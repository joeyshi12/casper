import type { KiroSubagentInfo, SubagentSummary } from '@casper/shared';

/** One stage as declared in a `subagent` tool call's `rawInput.stages[]`. */
export interface SubagentStageInput {
  name: string;
  depends_on?: string[];
}

/**
 * Tracks one chat's subagents, kept in memory for the life of the chat's process.
 * The parent's `subagent` tool_call declares every stage up front by name, including
 * ones waiting on a dependency; `_kiro.dev/subagent/list_update` carries the live
 * session id, status and activity for stages that started, but no tool call id of
 * its own. The two are joined by stage name, scoped to the most recent call still running.
 */
export class SubagentTracker {
  private readonly byChild = new Map<string, SubagentSummary>();
  private readonly pendingCalls: { toolCallId: string; stages: SubagentStageInput[] }[] = [];

  callStarted(toolCallId: string, stages: SubagentStageInput[]): void {
    this.pendingCalls.push({ toolCallId, stages });
  }

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

  /** Folds a list_update into the tracked state, returning links newly resolved
   *  this call, so the caller persists each one once. */
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

  /** Started stages plus a synthetic 'pending' row for each declared stage that
   *  hasn't started, so a stage waiting on a dependency still shows up. */
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

  list(): SubagentSummary[] {
    return [...this.byChild.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(sessionId: string): SubagentSummary | undefined {
    return this.byChild.get(sessionId);
  }
}
