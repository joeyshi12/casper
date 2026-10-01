import type { TranscriptItem } from '@casper/shared';

// The message kiro writes into a subagent session after it stops the session.
const INTERRUPTED = 'Tool uses were interrupted, waiting for the next user prompt';

/**
 * A subagent hands its result back by calling kiro's `summary` tool, and kiro stops the
 * session straight after. The session file then records that call as cancelled with an
 * error, followed by an "interrupted" message, though the subagent finished normally.
 * Show each `summary` call as the subagent's answer instead, and drop the interrupted
 * message.
 */
export function showSummaryAsAnswer(transcript: TranscriptItem[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const item of transcript) {
    if (item.type === 'message' && item.message.role === 'assistant' && item.message.text.trim() === INTERRUPTED) {
      continue;
    }
    if (item.type === 'tool_call' && item.tool.name === 'summary') {
      const input = item.tool.input as { taskResult?: unknown } | undefined;
      const result = typeof input?.taskResult === 'string' ? input.taskResult.trim() : '';
      if (result) out.push({ type: 'message', message: { id: item.tool.id, role: 'assistant', text: result } });
      continue;
    }
    out.push(item);
  }
  return out;
}
