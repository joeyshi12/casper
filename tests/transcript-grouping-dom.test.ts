// Proves the grouping and the live streaming thought are wired into the rendered transcript,
// not just correct as pure functions. Follows the harness in tests/transcript-dom.test.ts: a
// real DOM via jsdom, the real component, driven by state.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptItem } from '@casper/shared';
import { installDomGlobals } from './helpers.js';

type Any = any;

let createElement: Any;
let act: Any;
let createRoot: Any;
let Transcript: Any;
let useStore: Any;
let root: Any;
let host: HTMLElement;

const transcript = () => host.querySelector('.transcript') as HTMLElement;

const toolItem = (id: string, name: string, status = 'completed'): TranscriptItem =>
  ({
    type: 'tool_call',
    tool: { id, name, title: name, status, content: [], input: {} },
  }) as unknown as TranscriptItem;

const thought = (id: string, text = 'weighing the options'): TranscriptItem =>
  ({ type: 'message', message: { id, role: 'thinking', text } }) as unknown as TranscriptItem;

before(async () => {
  ({ host, react: { createElement, act } } = await installDomGlobals());
  ({ createRoot } = await import('react-dom/client'));
  ({ Transcript } = await import('../web/src/components/chat/Transcript.js'));
  ({ useStore } = await import('../web/src/state/store.js'));
});

after(() => {
  act(() => root?.unmount());
});

beforeEach(() => {
  useStore.getState().clearActive();
  useStore.setState({ activeId: 's1', items: [], remainingOlder: 0 });
  act(() => {
    root?.unmount();
    root = createRoot(host);
    root.render(createElement(Transcript));
  });
});

describe('a run that mixes thinking and tool calls (rendered in a DOM)', () => {
  it('folds think-call-think-call into one closed line, not four separate rows', () => {
    act(() => {
      useStore.setState({
        items: [thought('th1'), toolItem('t1', 'shell'), thought('th2'), toolItem('t2', 'read')],
      });
    });

    // One run line, not two "Thinking" rows plus two tool rows.
    const lines = transcript().querySelectorAll('.toolline');
    assert.equal(lines.length, 1, 'the run collapses to its one summary line');
    assert.equal(lines[0]!.textContent, 'Ran a command, read a file', 'thinking adds nothing to the text');
    assert.equal(transcript().querySelector('.toolline-box'), null, 'closed by default');
  });

  it('opening the run shows every member as a row, in order, including the thought rows', () => {
    act(() => {
      useStore.setState({
        items: [thought('th1'), toolItem('t1', 'shell'), thought('th2'), toolItem('t2', 'read')],
      });
    });

    const summaryLine = transcript().querySelector('.toolline') as HTMLElement;
    act(() => summaryLine.click());

    const rows = transcript().querySelectorAll('.toolline-box .toolline-row');
    assert.equal(rows.length, 4, 'all four members render as rows');
    const rowTexts = [...rows].map((r) => r.querySelector('.toolline-text')!.textContent);
    assert.deepEqual(rowTexts, ['Thinking', 'Ran a command', 'Thinking', 'Read']);
  });

  it('a run of only thinking messages reads "Thought" once closed', () => {
    act(() => {
      useStore.setState({ items: [thought('th1'), thought('th2')] });
    });

    const line = transcript().querySelector('.toolline') as HTMLElement;
    assert.equal(line.textContent, 'Thought');
  });

  it('opening a thought row reveals its text in muted italic, not the plain tool body style', () => {
    act(() => {
      useStore.setState({ items: [thought('th1', 'is this the right file?'), toolItem('t1', 'shell')] });
    });

    const summaryLine = transcript().querySelector('.toolline') as HTMLElement;
    act(() => summaryLine.click());
    const thoughtRowLine = transcript().querySelectorAll('.toolline-row .toolline')[0] as HTMLElement;
    act(() => thoughtRowLine.click());

    const text = transcript().querySelector('.thought-text');
    assert.ok(text, 'the thought text renders');
    assert.equal(text!.textContent, 'is this the right file?');
  });
});

describe('a lone thinking message outside any run (rendered in a DOM)', () => {
  it('is a plain line reading "Thinking", styled like a tool line rather than the old bordered block', () => {
    act(() => {
      useStore.setState({ items: [thought('th1')] });
    });

    const line = transcript().querySelector('.toolline') as HTMLElement;
    assert.ok(line, 'renders as a toolline, not the old .thought block');
    assert.equal(line.textContent, 'Thinking');
    assert.equal(transcript().querySelector('.thought-head'), null, 'the old bordered header is gone');
  });
});

describe('a live thought joining a trailing run (rendered in a DOM)', () => {
  it('does not render as a separate block below a trailing run of tool calls', () => {
    act(() => {
      useStore.setState({
        items: [toolItem('t1', 'shell'), toolItem('t2', 'read')],
        streamingThought: 'still working this out',
      });
    });

    // One line for the whole thing - the streaming thought joined the run - not a run
    // line plus a second standalone "Thinking" line underneath.
    const lines = transcript().querySelectorAll('.toolline');
    assert.equal(lines.length, 1, 'the live thought joined the run instead of appearing separately');
    assert.equal(lines[0]!.textContent, 'Thinking', 'a streaming thought takes over the group line');
    assert.ok(lines[0]!.querySelector('.toolline-text.is-live'), 'shimmer while the thought streams');
  });

  it('opening the joined run shows the live thought as its own trailing row', () => {
    act(() => {
      useStore.setState({
        items: [toolItem('t1', 'shell'), toolItem('t2', 'read')],
        streamingThought: 'still working this out',
      });
    });

    const line = transcript().querySelector('.toolline') as HTMLElement;
    act(() => line.click());

    const rows = transcript().querySelectorAll('.toolline-box .toolline-row');
    assert.equal(rows.length, 3, 'two tool rows plus the live thought row');
    const lastRowText = rows[rows.length - 1]!.querySelector('.toolline-text')!.textContent;
    assert.equal(lastRowText, 'Thinking');
  });

  it('a running tool call still wins the group line over a joined live thought', () => {
    act(() => {
      useStore.setState({
        items: [toolItem('t1', 'shell'), toolItem('t2', 'shell', 'in_progress')],
        streamingThought: 'still working this out',
      });
    });

    const line = transcript().querySelector('.toolline') as HTMLElement;
    assert.equal(line.textContent, 'Running a command', "the live tool call's own phrase wins");
  });

  it('does not join across a user message that followed the run', () => {
    act(() => {
      useStore.setState({
        items: [
          toolItem('t1', 'shell'),
          toolItem('t2', 'read'),
          { type: 'message', message: { id: 'u1', role: 'user', text: 'thanks' } } as unknown as TranscriptItem,
        ],
        streamingThought: 'thinking about the reply',
      });
    });

    // The run's own line, plus a separate standalone thought line after the user message.
    const lines = transcript().querySelectorAll('.toolline');
    assert.equal(lines.length, 2, 'the run keeps its own line and the thought gets its own');
    assert.equal(lines[1]!.textContent, 'Thinking');
  });
});

describe('an open run stays open while the turn adds to it (rendered in a DOM)', () => {
  const openRun = () => act(() => (transcript().querySelector('.toolline') as HTMLElement).click());
  const isOpen = () => transcript().querySelector('.toolline-box') !== null;

  it('stays open when another tool call joins the run', () => {
    act(() => useStore.setState({ items: [toolItem('t1', 'shell'), toolItem('t2', 'read')] }));
    openRun();
    act(() => useStore.setState({ items: [toolItem('t1', 'shell'), toolItem('t2', 'read'), toolItem('t3', 'grep')] }));
    assert.ok(isOpen(), 'the run is still open');
    assert.equal(transcript().querySelectorAll('.toolline-box .toolline-row').length, 3);
  });

  it('keeps an open thought row open when the streaming thought is saved', () => {
    act(() =>
      useStore.setState({ items: [toolItem('t1', 'shell'), toolItem('t2', 'read')], streamingThought: 'still deciding' }),
    );
    openRun();
    const liveRow = () => [...transcript().querySelectorAll('.toolline-box .toolline-row')].at(-1)!;
    act(() => (liveRow().querySelector('.toolline') as HTMLElement).click());
    assert.ok(liveRow().querySelector('.thought-text'), 'the live thought row is open');

    act(() =>
      useStore.setState({
        items: [toolItem('t1', 'shell'), toolItem('t2', 'read'), thought('th1', 'still deciding')],
        streamingThought: '',
      }),
    );
    assert.ok(isOpen(), 'the run is still open');
    assert.ok(liveRow().querySelector('.thought-text'), 'the saved thought row is still open');
  });
});

describe('the last group of a running turn shimmers (rendered in a DOM)', () => {
  const line = () => transcript().querySelector('.toolline-text') as HTMLElement;
  const setRunning = (running: boolean) =>
    useStore.setState((s: Any) => ({ observability: { ...s.observability, turnStatus: running ? 'running' : 'idle' } }));

  it('shimmers between calls while the turn is running, and stops when it ends', () => {
    act(() => {
      useStore.setState({ items: [toolItem('t1', 'shell'), toolItem('t2', 'read')] });
      setRunning(true);
    });
    assert.ok(line().classList.contains('is-live'), 'shimmers while more may follow');
    assert.equal(line().textContent, 'Ran a command, read a file', 'keeps its summary text');
    act(() => setRunning(false));
    assert.ok(!line().classList.contains('is-live'), 'stops once the turn ends');
  });

  it('an earlier group does not shimmer once a message follows it', () => {
    act(() => {
      useStore.setState({
        items: [
          toolItem('t1', 'shell'),
          toolItem('t2', 'read'),
          // A user message: an assistant message would load KaTeX's CSS, which tsx cannot import.
          { type: 'message', message: { id: 'u1', role: 'user', text: 'Next.' } } as unknown as TranscriptItem,
        ],
      });
      setRunning(true);
    });
    assert.ok(!line().classList.contains('is-live'));
  });
});

describe('a failed call in a run (rendered in a DOM)', () => {
  it('the group line is not red, and the failed row is red but starts closed', () => {
    // The failed call has an error message, so it has a body that could start open.
    const failed = toolItem('t2', 'read', 'failed') as Any;
    failed.tool.content = [{ type: 'content', content: { type: 'text', text: 'No such file or directory' } }];
    act(() => useStore.setState({ items: [toolItem('t1', 'shell'), failed] }));
    const groupLine = transcript().querySelector('.toolline') as HTMLElement;
    assert.ok(!groupLine.classList.contains('is-failed'), 'the group line stays its normal colour');
    act(() => groupLine.click());
    const failedRow = transcript().querySelectorAll('.toolline-box .toolline-row')[1]!;
    const rowLine = failedRow.querySelector('.toolline') as HTMLElement;
    assert.ok(rowLine.classList.contains('is-failed'), 'the failed row is red');
    assert.equal(rowLine.getAttribute('aria-expanded'), 'false', 'and closed');
    act(() => rowLine.click());
    assert.ok(failedRow.textContent?.includes('No such file or directory'), 'opening it shows the error');
  });
});

describe('folds open and close with the height animation (rendered in a DOM)', () => {
  it('a group and a lone thought put their content inside a collapse', () => {
    act(() => useStore.setState({ items: [toolItem('t1', 'shell'), toolItem('t2', 'read')] }));
    act(() => (transcript().querySelector('.toolline') as HTMLElement).click());
    assert.ok(transcript().querySelector('.collapse.is-open .toolline-box'), 'the group box is inside an open collapse');

    act(() => useStore.setState({ items: [thought('th1', 'a reason')] }));
    act(() => (transcript().querySelector('.toolline') as HTMLElement).click());
    assert.ok(transcript().querySelector('.collapse.is-open .thought-text'));
  });

  it('a thought with no text is not shown', () => {
    act(() => useStore.setState({ items: [thought('th1', '  ')] }));
    assert.equal(transcript().querySelector('.toolline') === null, true, 'no Thinking line');
  });
});

describe('the working dots (rendered in a DOM)', () => {
  const dots = () => transcript().querySelector('.thinking');
  const running = (items: TranscriptItem[]) =>
    act(() =>
      useStore.setState((s: Any) => ({ items, observability: { ...s.observability, turnStatus: 'running' } })),
    );

  it('are not shown while the last group shimmers, even after a pause', async () => {
    running([toolItem('t1', 'shell'), toolItem('t2', 'read')]);
    assert.equal(dots(), null);
    await new Promise((r) => setTimeout(r, 800));
    act(() => {});
    assert.equal(dots(), null, 'a pause in the turn does not bring them back');
  });

  it('are not shown while a lone thought ends a running turn, which shimmers instead', () => {
    running([thought('th1', 'a reason')]);
    assert.equal(dots(), null);
    assert.ok(transcript().querySelector('.toolline-text.is-live'));
  });

  it('are shown when nothing else shows progress', () => {
    running([{ type: 'message', message: { id: 'u1', role: 'user', text: 'Go' } } as unknown as TranscriptItem]);
    assert.ok(dots());
  });

  it('are shown when the last tool call failed, since a failed line does not shimmer', () => {
    running([toolItem('t1', 'shell', 'failed')]);
    assert.ok(dots());
  });
});
