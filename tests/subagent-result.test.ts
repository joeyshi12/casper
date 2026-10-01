import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptItem } from '@casper/shared';
import { showSummaryAsAnswer } from '../server/src/session/subagentResult.js';

const summaryCall = (taskResult: unknown, status = 'failed'): TranscriptItem => ({
  type: 'tool_call',
  tool: {
    id: 'sum-1',
    name: 'summary',
    title: 'summary',
    status,
    input: { taskDescription: 'Count files', taskResult },
    content: [{ type: 'content', content: { type: 'text', text: 'Tool use was cancelled by the user' } }],
  },
});
const assistant = (id: string, text: string): TranscriptItem => ({
  type: 'message',
  message: { id, role: 'assistant', text },
});
const shell: TranscriptItem = {
  type: 'tool_call',
  tool: { id: 'sh-1', name: 'shell', title: 'shell', status: 'completed', input: { command: 'ls' }, content: [] },
};

describe('showSummaryAsAnswer', () => {
  it('replaces the summary call with its result and drops the interrupted message', () => {
    const out = showSummaryAsAnswer([
      shell,
      assistant('a1', 'Now I will give the summary:'),
      summaryCall('There are 46 files.'),
      assistant('a2', 'Tool uses were interrupted, waiting for the next user prompt'),
    ]);
    assert.deepEqual(out, [
      shell,
      assistant('a1', 'Now I will give the summary:'),
      assistant('sum-1', 'There are 46 files.'),
    ]);
  });

  it('drops a summary call that has no result text', () => {
    assert.deepEqual(showSummaryAsAnswer([shell, summaryCall(undefined, 'completed')]), [shell]);
  });

  it('keeps other tool calls and messages, including failed ones', () => {
    const failed: TranscriptItem = {
      type: 'tool_call',
      tool: { ...(shell as { tool: object }).tool, id: 'sh-2', status: 'failed' } as never,
    };
    const items = [shell, failed, assistant('a1', 'Done.')];
    assert.deepEqual(showSummaryAsAnswer(items), items);
  });
});
