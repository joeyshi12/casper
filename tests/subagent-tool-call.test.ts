// The `subagent` tool call renders as one line that opens onto a list of its subagents,
// each row opening in place onto that subagent's own task and transcript. Rendered in a
// DOM the same way tests/transcript-dom.test.ts renders Transcript: jsdom computes no
// layout, so this proves the wiring (fetch on open, not before; the websocket event
// updating the list; a row opening its own transcript), not paint or geometry.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { SubagentSummary, TranscriptItem } from '@casper/shared';
import type { ToolCallView } from '../web/src/state/store.js';
import { installDomGlobals } from './helpers.js';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let ToolCallCard: Any;
let useStore: Any;
let api: Any;
let root: Any;
let host: HTMLElement;

const subagentTool = (status: ToolCallView['status'] = 'in_progress'): ToolCallView =>
  ({
    id: 'call-1',
    title: 'subagent',
    name: 'subagent',
    status,
    content: [],
    input: {
      stages: [
        { name: 'map_server', prompt_template: 'Map server/src.' },
        { name: 'map_web', prompt_template: 'Map web/src.' },
      ],
    },
  }) as unknown as ToolCallView;

const summary = (over: Partial<SubagentSummary>): SubagentSummary => ({
  sessionId: 'child-1',
  stageName: 'map_server',
  toolCallId: 'call-1',
  status: 'working',
  activity: 'Reading AGENTS.md',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

before(async () => {
  ({ host, react: { createElement, act } } = await installDomGlobals());
  // MarkdownRenderer preloads KaTeX when idle, and its CSS cannot be imported under tsx.
  (globalThis as Any).requestIdleCallback = () => {};
  ({ createRoot } = await import('react-dom/client'));
  ({ ToolCallCard } = await import('../web/src/components/chat/ToolCallCard.js'));
  ({ useStore } = await import('../web/src/state/store.js'));
  ({ api } = await import('../web/src/api/rest.js'));
});

after(() => {
  act(() => root?.unmount());
});

const render = (tool: ToolCallView) => {
  act(() => {
    root?.unmount();
    root = createRoot(host);
    root.render(createElement(ToolCallCard, { tool }));
  });
};

const pipelineLine = () => host.querySelector('.toolline') as HTMLElement | null;
const rows = () => host.querySelectorAll('.agent-row');
// Flush the microtask queue so a mocked fetch's .then() has run and committed its
// setState before the next assertion - a single `await Promise.resolve()` isn't always
// enough once a promise chain has more than one link.
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe('the subagent tool call (rendered in a DOM)', () => {
  let subagentsCalls: string[];
  let detailCalls: string[];
  let originalSubagents: Any;
  let originalDetail: Any;

  before(() => {
    originalSubagents = api.subagents;
    originalDetail = api.subagentDetail;
  });

  beforeEach(() => {
    useStore.getState().clearActive();
    useStore.setState({ activeId: 'chat-1' });
    subagentsCalls = [];
    detailCalls = [];
    api.subagents = async (chatId: string) => {
      subagentsCalls.push(chatId);
      return { subagents: [summary({ status: 'working' }), summary({ sessionId: 'child-2', stageName: 'map_web', status: 'pending', activity: 'Waits for map_server', createdAt: '', updatedAt: '' })] };
    };
    api.subagentDetail = async (_chatId: string, subagentId: string) => {
      detailCalls.push(subagentId);
      // A user-role message, not assistant: MarkdownRenderer schedules an idle katex
      // preload that outlives this test file in jsdom, which has no bearing on what
      // this test is proving (that a row renders its own transcript).
      const transcript: TranscriptItem[] = [
        { type: 'message', message: { id: 'm1', role: 'user', text: 'Mapped it.' } },
      ];
      return { subagent: summary({ sessionId: subagentId }), transcript };
    };
  });

  after(() => {
    api.subagents = originalSubagents;
    api.subagentDetail = originalDetail;
  });

  it('fetches the list once on mount, while still closed', async () => {
    const list = [summary({ status: 'completed' })];
    api.subagents = async (chatId: string) => (subagentsCalls.push(chatId), { subagents: list });
    render(subagentTool('completed'));
    await flush();
    assert.equal(pipelineLine()!.getAttribute('aria-expanded'), 'false', 'closed by default once finished');
    assert.deepEqual(subagentsCalls, ['chat-1']);
  });

  it('is open by default while the call is still running', async () => {
    render(subagentTool('in_progress'));
    await flush();
    assert.equal(pipelineLine()!.getAttribute('aria-expanded'), 'true');
  });

  it('shows one row per subagent with its stage name and activity', async () => {
    render(subagentTool('in_progress'));
    await flush();
    assert.equal(rows().length, 2);
    assert.ok(rows()[0]!.textContent?.includes('map_server'));
    assert.ok(rows()[0]!.textContent?.includes('Reading AGENTS.md'));
    assert.ok(rows()[1]!.textContent?.includes('Waits for map_server'));
  });

  it('does not fetch a row transcript until that row is opened', async () => {
    render(subagentTool('in_progress'));
    await flush();
    assert.deepEqual(detailCalls, [], 'no row has been opened yet');

    act(() => (rows()[0] as HTMLElement).click());
    await flush();
    assert.deepEqual(detailCalls, ['child-1'], 'only the opened row fetched its transcript');
  });

  const tool = (id: string, status = 'completed'): TranscriptItem =>
    ({ type: 'tool_call', tool: { id, name: 'shell', title: 'shell', status, input: {}, content: [] } }) as unknown as TranscriptItem;
  const say = (id: string, text: string): TranscriptItem =>
    ({ type: 'message', message: { id, role: 'assistant', text } }) as TranscriptItem;
  // A prompt, then 20 rounds of a tool call and a message, then the answer.
  const longTranscript = (): TranscriptItem[] => [
    { type: 'message', message: { id: 'p', role: 'user', text: 'The long prompt.' } },
    ...Array.from({ length: 20 }, (_, i) => [tool(`t${i}`), say(`s${i}`, `Step ${i}.`)]).flat(),
    say('answer', 'The answer.'),
  ];
  const openRow = async (status: 'working' | 'completed', transcript: TranscriptItem[]) => {
    api.subagents = async () => ({ subagents: [summary({ status })] });
    api.subagentDetail = async (_c: string, id: string) => (detailCalls.push(id), { subagent: summary({ status }), transcript });
    render(subagentTool(status === 'working' ? 'in_progress' : 'completed'));
    await flush();
    if (pipelineLine()!.getAttribute('aria-expanded') !== 'true') act(() => pipelineLine()!.click());
    act(() => (rows()[0] as HTMLElement).click());
    await flush();
  };
  const stepsLine = () => [...host.querySelectorAll('.agent-transcript > div > .toolline')][0] as HTMLElement;
  const stepCount = () => host.querySelectorAll('.agent-steps > .toolline-wrap, .agent-steps > .msg').length;

  it('a finished row shows its answer, with the steps behind a closed totals line', async () => {
    await openRow('completed', longTranscript());
    assert.ok(host.querySelector('.agent-transcript > .msg-assistant')?.textContent?.includes('The answer.'));
    assert.match(stepsLine().textContent ?? '', /^21 messages and 20 tool calls over /);
    assert.equal(stepsLine().getAttribute('aria-expanded'), 'false');
    assert.ok(!host.textContent?.includes('The long prompt.'), 'the prompt is not shown');
  });

  it('a running row shows only the latest 6 steps, with totals so far', async () => {
    await openRow('working', longTranscript());
    assert.equal(host.querySelector('.agent-transcript > .msg-assistant') === null, true, 'no answer yet');
    assert.match(stepsLine().textContent ?? '', /^21 messages and 20 tool calls so far/);
    assert.equal(stepsLine().getAttribute('aria-expanded'), 'true', 'the steps show at once');
    assert.equal(stepCount(), 6);
  });

  it('"Show earlier" adds 40 older steps inside a scrolling box', async () => {
    await openRow('working', longTranscript());
    const earlier = host.querySelector('.agent-earlier') as HTMLElement;
    assert.equal(earlier.textContent, 'Show 36 earlier of 36');
    act(() => earlier.click());
    assert.equal(stepCount(), 42, 'the prompt, 20 tool calls and 21 messages');
    assert.ok(host.querySelector('.agent-steps.is-paged'), 'capped so the row does not grow');
    assert.equal(host.querySelector('.agent-earlier'), null, 'nothing earlier is left');
  });

  it('renders messages like the chat and folds consecutive tool calls and thinking into one line', async () => {
    const think = (id: string): TranscriptItem =>
      ({ type: 'message', message: { id, role: 'thinking', text: 'Weighing it.' } }) as TranscriptItem;
    await openRow('working', [say('a', 'Looking at the loader.'), think('h1'), tool('x1'), think('h2'), tool('x2'), tool('x3')]);
    assert.ok(host.querySelector('.agent-steps > .msg.msg-assistant'), 'a message renders as a chat message');
    const groups = [...host.querySelectorAll('.agent-steps > .toolline-wrap > .toolline')].map((b) => b.textContent);
    assert.deepEqual(groups, ['Ran 3 commands'], 'one fold for the run of tool calls and thinking');
  });

  it('a running row fetches its transcript again while it is open', async () => {
    await openRow('working', longTranscript());
    const before = detailCalls.length;
    await act(() => new Promise((r) => setTimeout(r, 3100)));
    assert.ok(detailCalls.length > before, 'polled for new steps');
  });

  it('shows a row per declared stage while the list is still loading, not an empty box', async () => {
    let finish: (v: unknown) => void = () => {};
    api.subagents = () => new Promise((r) => (finish = r));
    render(subagentTool('completed'));
    act(() => (pipelineLine() as HTMLElement).click());
    const names = [...rows()].map((r) => r.querySelector('.agent-name')?.textContent);
    assert.deepEqual(names, ['map_server', 'map_web']);
    assert.ok(rows()[0]!.querySelector('.agent-what.is-live'), 'each row says it is loading');
    finish({ subagents: [summary({ status: 'completed' }), summary({ sessionId: 'child-2', stageName: 'map_web', status: 'completed' })] });
    await flush();
    assert.ok(rows()[0]!.textContent?.includes('Done'), 'the loaded status replaces it');
  });

  it('is not shown when nothing was saved for a finished call', async () => {
    api.subagents = async () => ({ subagents: [] });
    render(subagentTool('completed'));
    await flush();
    assert.equal(pipelineLine() === null, true, 'the call line is not rendered');
  });

  it('stays shown while running, even before any subagent is listed', async () => {
    api.subagents = async () => ({ subagents: [] });
    render(subagentTool('in_progress'));
    await flush();
    assert.ok(pipelineLine());
    assert.equal(rows().length, 2, 'one row per declared stage');
  });

  it('the pending row has no elapsed time shown', async () => {
    render(subagentTool('in_progress'));
    await flush();
    const pendingRow = rows()[1]!;
    assert.equal(pendingRow.querySelector('.agent-time')?.textContent, '');
  });

  it('shows "Running N subagents, M done" while the call is in progress', async () => {
    render(subagentTool('in_progress'));
    await flush();
    assert.equal(pipelineLine()!.textContent?.includes('Running 2 subagents'), true);
  });

  it('shows "Ran N subagents" once finished, and updates live from the subagents_changed event', async () => {
    api.subagents = async () => ({ subagents: [summary({ status: 'completed' })] });
    render(subagentTool('completed'));
    await flush();
    assert.ok(pipelineLine()!.textContent?.startsWith('Ran'), 'past tense once the call is done');

    // The event the server pushes on a list_update; applyEvent folds it straight into
    // the store the row reads from, with no extra fetch.
    act(() => {
      useStore.getState().applyEvent({
        seq: 1,
        ts: Date.now(),
        chatId: 'chat-1',
        payload: {
          kind: 'subagents_changed',
          subagents: [
            summary({ status: 'completed', activity: undefined }),
            summary({ sessionId: 'child-2', stageName: 'map_web', status: 'completed', activity: undefined }),
          ],
        },
      });
    });
    assert.equal(pipelineLine()!.textContent, 'Ran 2 subagents');
  });
});
