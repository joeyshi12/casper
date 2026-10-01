// Run with: npm test
//
// The pure grouping function Transcript uses to fold a turn's thinking and tool calls into
// one run, and the text helpers that label a call and summarise a run.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptItem } from '@casper/shared';
import { groupToolCalls, lastEntryJoinsStreamingThought } from '../web/src/util/toolGroups.js';
import { toolPhrase, toolRunSummary, runSummary } from '../web/src/util/toolRender.js';

const toolItem = (id: string, name: string, input: unknown = {}, status = 'completed'): TranscriptItem =>
  ({
    type: 'tool_call',
    tool: { id, name, title: name, status, content: [], input },
  }) as unknown as TranscriptItem;

const message = (id: string, role: 'user' | 'assistant' = 'assistant'): TranscriptItem =>
  ({ type: 'message', message: { id, role, text: 'hi' } }) as unknown as TranscriptItem;

const thought = (id: string, text = 'thinking it over'): TranscriptItem =>
  ({ type: 'message', message: { id, role: 'thinking', text } }) as unknown as TranscriptItem;

const widgetItem = (id: string): TranscriptItem =>
  toolItem(id, 'casper/show_widget', { title: 'chart', widget_code: '<div></div>' });

const choiceItem = (id: string): TranscriptItem =>
  toolItem(id, 'casper/show_choice', {
    question: 'Which one?',
    options: [{ label: 'a', prompt: 'a' }, { label: 'b', prompt: 'b' }],
  });

const subagentItem = (id: string): TranscriptItem => toolItem(id, 'subagent', { stages: [] });

type RunEntry = { type: 'run'; members: { type: string; tool?: { id: string } }[] };

describe('groupToolCalls', () => {
  it('leaves a single tool call on its own, not wrapped in a run', () => {
    const out = groupToolCalls([toolItem('t1', 'read')]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, 'tool');
  });

  it('leaves a single thinking message on its own, not wrapped in a run', () => {
    const out = groupToolCalls([thought('th1')]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, 'thought');
  });

  it('folds two or more consecutive tool calls into one run', () => {
    const out = groupToolCalls([toolItem('t1', 'shell'), toolItem('t2', 'read'), toolItem('t3', 'read')]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, 'run');
    const ids = (out[0] as RunEntry).members.map((m) => m.tool?.id);
    assert.deepEqual(ids, ['t1', 't2', 't3']);
  });

  it('a thinking message between two tool calls joins the run rather than breaking it', () => {
    const out = groupToolCalls([toolItem('t1', 'shell'), thought('th1'), toolItem('t2', 'read')]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, 'run');
    const members = (out[0] as RunEntry).members;
    assert.deepEqual(members.map((m) => m.type), ['tool', 'thought', 'tool']);
  });

  it('a run of think, call, think, call folds into one run of four members', () => {
    const out = groupToolCalls([
      thought('th1'),
      toolItem('t1', 'shell'),
      thought('th2'),
      toolItem('t2', 'read'),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, 'run');
    assert.equal((out[0] as RunEntry).members.length, 4);
  });

  it('a run of only thinking messages still folds once there are two or more', () => {
    const out = groupToolCalls([thought('th1'), thought('th2')]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, 'run');
    const members = (out[0] as RunEntry).members;
    assert.deepEqual(members.map((m) => m.type), ['thought', 'thought']);
  });

  it('an assistant message between two tool calls breaks the run', () => {
    const out = groupToolCalls([toolItem('t1', 'shell'), message('m1'), toolItem('t2', 'read')]);
    assert.equal(out.length, 3);
    assert.equal(out[0]!.type, 'tool');
    assert.equal(out[1]!.type, 'other');
    assert.equal(out[2]!.type, 'tool');
  });

  it('a widget call is never grouped and breaks a run around it', () => {
    const out = groupToolCalls([toolItem('t1', 'shell'), widgetItem('w1'), toolItem('t2', 'read')]);
    assert.equal(out.length, 3);
    assert.equal(out[0]!.type, 'tool');
    assert.equal(out[1]!.type, 'other');
    assert.equal(out[2]!.type, 'tool');
  });

  it('a choice template is never grouped and breaks a run around it', () => {
    const out = groupToolCalls([toolItem('t1', 'shell'), choiceItem('c1'), toolItem('t2', 'read')]);
    assert.equal(out.length, 3);
    assert.equal(out[1]!.type, 'other');
  });

  it('a subagent call is never grouped and breaks a run around it', () => {
    const out = groupToolCalls([toolItem('t1', 'shell'), subagentItem('s1'), toolItem('t2', 'read')]);
    assert.equal(out.length, 3);
    assert.equal(out[1]!.type, 'other');
  });

  it('two runs stay separate across the message that splits them', () => {
    const out = groupToolCalls([
      toolItem('t1', 'shell'),
      toolItem('t2', 'read'),
      message('m1'),
      toolItem('t3', 'grep'),
      toolItem('t4', 'read'),
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0]!.type, 'run');
    assert.equal(out[1]!.type, 'other');
    assert.equal(out[2]!.type, 'run');
  });

  it('an empty transcript produces no entries', () => {
    assert.deepEqual(groupToolCalls([]), []);
  });
});

describe('lastEntryJoinsStreamingThought', () => {
  it('nothing to join when the transcript is empty', () => {
    assert.equal(lastEntryJoinsStreamingThought(undefined), false);
  });

  it('a trailing run accepts the live thought', () => {
    const out = groupToolCalls([toolItem('t1', 'shell'), toolItem('t2', 'read')]);
    assert.equal(lastEntryJoinsStreamingThought(out[0]), true);
  });

  it('a trailing lone tool call accepts the live thought', () => {
    const out = groupToolCalls([toolItem('t1', 'shell')]);
    assert.equal(lastEntryJoinsStreamingThought(out[0]), true);
  });

  it('a trailing lone thought accepts the live thought', () => {
    const out = groupToolCalls([thought('th1')]);
    assert.equal(lastEntryJoinsStreamingThought(out[0]), true);
  });

  it('a trailing assistant message refuses the live thought', () => {
    const out = groupToolCalls([message('m1')]);
    assert.equal(lastEntryJoinsStreamingThought(out[0]), false);
  });

  it('a trailing widget call refuses the live thought', () => {
    const out = groupToolCalls([widgetItem('w1')]);
    assert.equal(lastEntryJoinsStreamingThought(out[0]), false);
  });
});

describe('toolPhrase', () => {
  it('the agent-stated purpose wins over any kind phrase', () => {
    const tool = { name: 'shell', input: { __tool_use_purpose: 'Checked the build' } };
    assert.equal(toolPhrase(tool, false), 'Checked the build');
  });

  it('a shell call with no purpose reads as a plain command phrase', () => {
    assert.equal(toolPhrase({ name: 'shell', input: { command: 'npm test' } }, false), 'Ran a command');
    assert.equal(toolPhrase({ name: 'shell', input: { command: 'npm test' } }, true), 'Running a command');
  });

  it('a read names its file, past tense when done and present tense while running', () => {
    const tool = { name: 'read', input: { operations: [{ mode: 'Line', path: '/a/b/AGENTS.md' }] } };
    assert.equal(toolPhrase(tool, false), 'Read AGENTS.md');
    assert.equal(toolPhrase(tool, true), 'Reading AGENTS.md');
  });

  it('a write names its file', () => {
    const tool = { name: 'write', input: { path: '/a/b/app.css', command: 'create' } };
    assert.equal(toolPhrase(tool, false), 'Wrote app.css');
  });

  it('a grep names its pattern', () => {
    const tool = { name: 'grep', input: { pattern: 'mapNotification' } };
    assert.equal(toolPhrase(tool, false), 'Searched mapNotification');
  });

  it('a web fetch names the host, not the full url', () => {
    const tool = { name: 'web_fetch', input: { url: 'https://example.com/a/b?x=1' } };
    assert.equal(toolPhrase(tool, false), 'Fetched example.com');
  });

  it('a tool kind with no target in its input falls back to the plain verb', () => {
    assert.equal(toolPhrase({ name: 'web_search', input: {} }, false), 'Searched the web');
  });
});

describe('toolRunSummary', () => {
  it('one of a kind reads as singular', () => {
    const tools = [{ name: 'shell', input: {} }];
    assert.equal(toolRunSummary(tools), 'Ran a command');
  });

  it('counts repeats of the same kind', () => {
    const tools = [
      { name: 'read', input: {} },
      { name: 'read', input: {} },
    ];
    assert.equal(toolRunSummary(tools), 'Read 2 files');
  });

  it('joins different kinds in the order they first appear', () => {
    const tools = [
      { name: 'shell', input: {} },
      { name: 'read', input: {} },
      { name: 'read', input: {} },
    ];
    assert.equal(toolRunSummary(tools), 'Ran a command, read 2 files');
  });
});

describe('runSummary', () => {
  it('a run with tool calls reads the same as toolRunSummary - thinking adds nothing', () => {
    const tools = [{ name: 'shell', input: {} }, { name: 'read', input: {} }];
    assert.equal(runSummary(tools), toolRunSummary(tools));
  });

  it('a run with no tool calls at all, only thoughts, reads "Thought"', () => {
    assert.equal(runSummary([]), 'Thought');
  });
});
