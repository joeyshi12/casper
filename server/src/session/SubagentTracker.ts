import type { SubagentSummary } from '@casper/shared';

/**
 * Tracks one chat's subagents, kept in memory for the life of the chat's process. kiro
 * starts each subagent with a tool call of its own, whose `_meta.kiro.agentSubtaskId`
 * names the subagent, and sends the subagent's own updates on the parent's session
 * tagged with that id. Each method returns whether the list changed, so the caller
 * records a `subagents_changed` event only then.
 */
export class SubagentTracker {
  private readonly byId = new Map<string, SubagentSummary>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  /** The tool call that starts a subagent arrived. */
  started(subagentId: string, toolCallId: string, name: string): boolean {
    if (this.byId.has(subagentId)) return false;
    const at = this.now();
    this.byId.set(subagentId, {
      sessionId: subagentId,
      stageName: name,
      toolCallId,
      status: 'working',
      createdAt: at,
      updatedAt: at,
    });
    return true;
  }

  /** One of the subagent's own updates arrived. `activity` is the title of a tool call it
   *  started, which becomes the row's "what it is doing now". */
  progressed(subagentId: string, activity?: string): boolean {
    const s = this.byId.get(subagentId);
    if (!s || s.status !== 'working') return false;
    s.updatedAt = this.now();
    if (!activity || activity === s.activity) return false;
    s.activity = activity;
    return true;
  }

  /** The call that started a subagent finished. */
  finished(toolCallId: string, ok: boolean): boolean {
    for (const s of this.byId.values()) {
      if (s.toolCallId !== toolCallId || s.status !== 'working') continue;
      s.status = ok ? 'completed' : 'failed';
      s.activity = undefined;
      s.updatedAt = this.now();
      return true;
    }
    return false;
  }

  /** Called when the parent turn ends. The turn waits on its subagents, so any still
   *  working was stopped with it, and kiro does not always report that. */
  turnEnded(): boolean {
    let changed = false;
    for (const s of this.byId.values()) {
      if (s.status !== 'working') continue;
      s.status = 'failed';
      s.activity = 'Stopped';
      s.updatedAt = this.now();
      changed = true;
    }
    return changed;
  }

  /** Copies, so a recorded event keeps the state it was recorded with. */
  list(): SubagentSummary[] {
    return [...this.byId.values()]
      .map((s) => ({ ...s }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(subagentId: string): SubagentSummary | undefined {
    const s = this.byId.get(subagentId);
    return s && { ...s };
  }
}
