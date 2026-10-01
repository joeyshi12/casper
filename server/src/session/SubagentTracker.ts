import type { KiroSubagentInfo, SubagentSummary } from '@casper/shared';

/** One stage as declared in a `subagent` tool call's `rawInput.stages[]`. */
export interface SubagentStageInput {
  name: string;
  depends_on?: string[];
}

/**
 * Tracks one chat's subagents (child kiro sessions spawned by its `subagent` tool
 * calls), kept in memory for the life of the chat's process.
 *
 * Two notifications feed this, and each knows something the other doesn't:
 *   - The parent's `subagent` tool_call carries every declared stage up front, by name,
 *     including ones still waiting on a dependency - which is the only way to show
 *     "pending" at all, because a pending stage has no session id yet and never
 *     appears in list_update.
 *   - `_kiro.dev/subagent/list_update` carries the live session id, status and
 *     activity for stages that have actually started, but nothing waiting is in it,
 *     and it carries no session id or tool call id of its own to say which parent
 *     call it belongs to.
 *
 * The two are joined by stage name, scoped to the most recently started call still
 * running: Casper spawns one kiro-cli child per chat (see KiroProcess), so every
 * list_update seen on a chat's process belongs to that chat's own subagents, and a
 * stage name only repeats across different calls, never within one.
 */
export class SubagentTracker {
  private readonly byChild = new Map<string, SubagentSummary>();
  // Pending subagent tool calls, most recent last, each with its declared stages.
  private readonly pendingCalls: { toolCallId: string; stages: SubagentStageInput[] }[] = [];

  /** A `subagent` tool call just started: remember its stages for name matching. */
  callStarted(toolCallId: string, stages: SubagentStageInput[]): void {
    this.pendingCalls.push({ toolCallId, stages });
  }

  /** The `subagent` tool call finished: nothing more will match its stage names. */
  callFinished(toolCallId: string): void {
    const i = this.pendingCalls.findIndex((c) => c.toolCallId === toolCallId);
    if (i >= 0) this.pendingCalls.splice(i, 1);
  }

  private callFor(stageName: string): { toolCallId: string; stages: SubagentStageInput[] } | undefined {
    for (let i = this.pendingCalls.length - 1; i >= 0; i--) {
      if (this.pendingCalls[i]!.stages.some((s) => s.name === stageName)) return this.pendingCalls[i];
    }
    return undefined;
  }

  /**
   * Fold a list_update notification into the tracked state. Returns the links newly
   * resolved by this call (a child whose toolCallId just became known), so the caller
   * can persist them - once resolved a child keeps the same toolCallId for the rest of
   * this tracker's life, so each link only needs to be persisted once.
   */
  apply(
    subagents: KiroSubagentInfo[],
    now: () => string = () => new Date().toISOString(),
  ): { sessionId: string; toolCallId: string; stageName: string }[] {
    const resolved: { sessionId: string; toolCallId: string; stageName: string }[] = [];
    for (const info of subagents) {
      const existing = this.byChild.get(info.sessionId);
      const nowIso = now();
      const toolCallId = existing?.toolCallId ?? this.callFor(info.sessionName)?.toolCallId;
      if (toolCallId && !existing?.toolCallId) {
        resolved.push({ sessionId: info.sessionId, toolCallId, stageName: info.sessionName });
      }
      this.byChild.set(info.sessionId, {
        sessionId: info.sessionId,
        stageName: info.sessionName,
        toolCallId,
        status: info.status.type === 'terminated' ? 'completed' : 'working',
        activity: info.status.message,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      });
    }
    return resolved;
  }

  /**
   * The full list for one `subagent` tool call: started stages from list_update, plus a
   * synthetic 'pending' row for each declared stage that hasn't started yet, so a stage
   * waiting on a dependency shows up at all.
   */
  listForCall(toolCallId: string): SubagentSummary[] {
    const call = this.pendingCalls.find((c) => c.toolCallId === toolCallId);
    const started = [...this.byChild.values()].filter((s) => s.toolCallId === toolCallId);
    if (!call) return started.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const startedNames = new Set(started.map((s) => s.stageName));
    const pending: SubagentSummary[] = call.stages
      .filter((s) => !startedNames.has(s.name))
      .map((s) => ({
        sessionId: `pending:${toolCallId}:${s.name}`,
        stageName: s.name,
        toolCallId,
        status: 'pending',
        activity: s.depends_on?.length ? `Waits for ${s.depends_on.join(' and ')}` : undefined,
        createdAt: '',
        updatedAt: '',
      }));
    return [...started.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), ...pending];
  }

  /** Every tracked subagent, across every call this chat has ever run. */
  list(): SubagentSummary[] {
    return [...this.byChild.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(sessionId: string): SubagentSummary | undefined {
    return this.byChild.get(sessionId);
  }
}
