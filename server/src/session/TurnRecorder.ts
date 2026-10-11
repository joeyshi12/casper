import {
  commitDraft,
  emptyDraft,
  foldSessionUpdate,
  settleTools,
  stripAttachmentsLine,
  type CasperEvent,
  type SessionUpdate,
  type TranscriptItem,
  type TurnDraft,
  type TurnEnding,
} from '@casper/shared';

const MAX_STRING = 20_000;

const isImage = (block: unknown): boolean => {
  const b = block as { type?: string; content?: { type?: string } } | null;
  return b?.type === 'image' || b?.content?.type === 'image';
};

function cap(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}\n[truncated]` : value;
  }
  if (Array.isArray(value)) return value.filter((v) => !isImage(v)).map(cap);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cap(v)]));
  }
  return value;
}

const bounded = (items: TranscriptItem[]): TranscriptItem[] =>
  items.map((it) =>
    it.type === 'tool_call'
      ? {
          type: 'tool_call',
          tool: {
            ...it.tool,
            input: cap(it.tool.input),
            output: cap(it.tool.output),
            content: cap(it.tool.content) as unknown[],
          },
        }
      : it,
  );

/** Follows the turn in progress so that a turn which fails or is stopped can be stored. */
export class TurnRecorder {
  private draft: TurnDraft | null = null;
  private startedAt = 0;
  private prompt = '';

  observe(e: CasperEvent): void {
    const p = e.payload;
    if (p.kind === 'turn_started') {
      this.draft = emptyDraft();
      this.startedAt = e.ts;
      this.prompt = stripAttachmentsLine(
        p.prompt
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join(''),
      );
    } else if (p.kind === 'session_update' && this.draft) {
      this.draft = foldSessionUpdate(this.draft, p.update as SessionUpdate, e.seq, e.ts);
    }
  }

  /** Null when no turn was being followed. */
  finish(
    ending: { kind: 'failed'; message: string } | { kind: 'interrupted' },
    endedAt = Date.now(),
  ): TurnEnding | null {
    const draft = this.draft;
    this.draft = null;
    if (!draft) return null;
    return {
      startedAt: this.startedAt,
      endedAt,
      prompt: this.prompt,
      ...ending,
      items: bounded(settleTools(commitDraft(draft, `end-${endedAt}`, endedAt))),
    };
  }

  discard(): void {
    this.draft = null;
  }
}
