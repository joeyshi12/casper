// matchSubagentsFallback is a small pure function: given the `subagent` tool calls in a
// parent's transcript and the on-disk children with no recorded link, it matches each
// child to the stage whose expanded prompt its title is the start of. Fixtures below are
// shaped like what inspecting real files under ~/.kiro/sessions/cli showed: a child's
// title is the stage's prompt_template with {task} filled in, cut to 150 characters.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptItem } from '@casper/shared';
import type { ChildSession } from '../server/src/session/kiroFiles.js';
import { matchSubagentsFallback, subagentCallsIn } from '../server/src/session/subagentFallbackMatch.js';

// A `subagent` tool_call item, same shape hydrateTranscript produces: name is the raw
// tool name, input is the rawInput kiro sent (task, mode, stages[]).
function subagentToolCallItem(
  toolCallId: string,
  task: string,
  stages: { name: string; prompt_template?: string }[],
): TranscriptItem {
  return {
    type: 'tool_call',
    tool: {
      id: toolCallId,
      name: 'subagent',
      title: 'subagent',
      status: 'completed',
      input: { task, mode: 'blocking', stages },
      content: [],
    },
  };
}

function childFixture(sessionId: string, title: string, createdAt: string): ChildSession {
  return {
    sessionId,
    title,
    cwd: '/work',
    createdAt,
    updatedAt: createdAt,
    parentSessionId: 'parent-1',
  };
}

describe('subagentCallsIn', () => {
  it('finds a subagent tool call among plain ones, keeping transcript order', () => {
    const transcript: TranscriptItem[] = [
      { type: 'message', message: { id: 'm1', role: 'user', text: 'hi' } },
      subagentToolCallItem('call-1', 'do the thing', [{ name: 'stage_a' }]),
      { type: 'tool_call', tool: { id: 'plain-1', name: 'shell', title: 'shell', status: 'completed', content: [] } },
      subagentToolCallItem('call-2', 'do another thing', [{ name: 'stage_b' }]),
    ];
    const calls = subagentCallsIn(transcript);
    assert.deepEqual(calls.map((c) => c.toolCallId), ['call-1', 'call-2']);
    assert.ok(calls[0]!.itemIndex < calls[1]!.itemIndex);
  });

  it('ignores a tool call with no stages (not a subagent spawn)', () => {
    const transcript: TranscriptItem[] = [
      { type: 'tool_call', tool: { id: 'x', name: 'subagent', title: 'subagent', status: 'completed', input: {}, content: [] } },
    ];
    assert.deepEqual(subagentCallsIn(transcript), []);
  });
});

describe('matchSubagentsFallback', () => {
  it('matches a child whose title is the start of its stage\'s expanded prompt', () => {
    const transcript = [
      subagentToolCallItem('call-1', 'Port the input layer.', [
        { name: 'input_layer', prompt_template: '{task}\n\nYOUR TASK: port scripts/input.gd with tests.' },
      ]),
    ];
    const children = [childFixture('child-1', 'Port the input layer.\n\nYOUR TASK: port scripts/input', '2026-01-01T00:00:00Z')];
    const matches = matchSubagentsFallback(subagentCallsIn(transcript), children);
    assert.deepEqual(matches, [{ sessionId: 'child-1', toolCallId: 'call-1', stageName: 'input_layer' }]);
  });

  it('matches a child whose title is a verbatim, untruncated prompt (shorter than 150 chars)', () => {
    const transcript = [
      subagentToolCallItem('call-1', 'Clean up my casper sessions.', []),
    ];
    // No stages[] entries: a call declared with an empty stage list. Nothing to match
    // against, so the child stays unclaimed.
    const children = [childFixture('child-1', 'Clean up my casper sessions.', '2026-01-01T00:00:00Z')];
    assert.deepEqual(matchSubagentsFallback(subagentCallsIn(transcript), children), []);
  });

  it('matches each stage of a multi-stage call to a different child', () => {
    const transcript = [
      subagentToolCallItem('call-1', 'Port two modules.', [
        { name: 'combo', prompt_template: '{task}\n\nPort the combo layer.' },
        { name: 'constants', prompt_template: '{task}\n\nPort the frame constants.' },
      ]),
    ];
    const children = [
      childFixture('child-combo', 'Port two modules.\n\nPort the combo layer.', '2026-01-01T00:00:00Z'),
      childFixture('child-constants', 'Port two modules.\n\nPort the frame constants.', '2026-01-01T00:01:00Z'),
    ];
    const matches = matchSubagentsFallback(subagentCallsIn(transcript), children);
    assert.deepEqual(
      matches.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
      [
        { sessionId: 'child-combo', toolCallId: 'call-1', stageName: 'combo' },
        { sessionId: 'child-constants', toolCallId: 'call-1', stageName: 'constants' },
      ],
    );
  });

  it('leaves a child out entirely when no stage prompt matches its title', () => {
    const transcript = [
      subagentToolCallItem('call-1', 'Do a thing.', [{ name: 'stage_a', prompt_template: '{task} with stage A' }]),
    ];
    const children = [childFixture('child-unrelated', 'Something else altogether', '2026-01-01T00:00:00Z')];
    assert.deepEqual(matchSubagentsFallback(subagentCallsIn(transcript), children), []);
  });

  it('does not reuse a child that is already claimed by an earlier call', () => {
    const transcript = [
      subagentToolCallItem('call-1', 'Fix the bug.', [{ name: 'fix', prompt_template: '{task} - round one' }]),
      subagentToolCallItem('call-2', 'Fix the bug.', [{ name: 'fix', prompt_template: '{task} - round one' }]),
    ];
    // Two children with the same resulting title (a retried call reusing the same stage
    // name and prompt) - each call claims a different one, earliest child first.
    const children = [
      childFixture('child-first', 'Fix the bug. - round one', '2026-01-01T00:00:00Z'),
      childFixture('child-second', 'Fix the bug. - round one', '2026-01-01T00:01:00Z'),
    ];
    const matches = matchSubagentsFallback(subagentCallsIn(transcript), children);
    assert.equal(matches.length, 2);
    assert.equal(matches.find((m) => m.toolCallId === 'call-1')?.sessionId, 'child-first');
    assert.equal(matches.find((m) => m.toolCallId === 'call-2')?.sessionId, 'child-second');
  });

  it('matches a title truncated to 150 characters against a longer expanded prompt', () => {
    const longTail = 'x'.repeat(200);
    const transcript = [
      subagentToolCallItem('call-1', 'start', [{ name: 'long_stage', prompt_template: `{task} ${longTail}` }]),
    ];
    const fullExpansion = `start ${longTail}`;
    const truncatedTitle = fullExpansion.slice(0, 150);
    const children = [childFixture('child-1', truncatedTitle, '2026-01-01T00:00:00Z')];
    const matches = matchSubagentsFallback(subagentCallsIn(transcript), children);
    assert.deepEqual(matches, [{ sessionId: 'child-1', toolCallId: 'call-1', stageName: 'long_stage' }]);
  });
});
