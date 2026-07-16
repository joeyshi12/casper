import {
  emptyObservabilitySnapshot,
  type CasperEventPayload,
  type McpServerHealth,
  type ObservabilitySnapshot,
} from '@casper/shared';

/**
 * Folds the stream of Casper events into a live observability snapshot:
 * cumulative credits, context-window usage, turn duration, MCP health,
 * subagents, available commands, and OAuth prompts.
 *
 * Pure and deterministic - unit-tested by replaying a fixture set.
 */
export class TurnState {
  private snapshot: ObservabilitySnapshot = emptyObservabilitySnapshot();

  get(): ObservabilitySnapshot {
    return this.snapshot;
  }

  /** Apply one event; returns the updated snapshot. */
  apply(payload: CasperEventPayload): ObservabilitySnapshot {
    const s = this.snapshot;
    switch (payload.kind) {
      case 'turn_started': {
        this.snapshot = { ...s, turnStatus: 'running', currentTurnStartedAt: Date.now() };
        break;
      }
      case 'turn_ended': {
        this.snapshot = { ...s, turnStatus: 'idle', currentTurnStartedAt: undefined };
        break;
      }
      case 'turn_error': {
        this.snapshot = { ...s, turnStatus: 'idle', currentTurnStartedAt: undefined };
        break;
      }
      case 'process_exited': {
        // The kiro process died; any in-flight turn is over. Match the client
        // reducer so a REST refetch after a crash does not report 'running'.
        this.snapshot = { ...s, turnStatus: 'idle', currentTurnStartedAt: undefined };
        break;
      }
      case 'metadata': {
        const p = payload.params;
        const turnCredits = (p.meteringUsage ?? []).reduce((sum, m) => sum + m.value, 0);
        this.snapshot = {
          ...s,
          contextUsagePercentage: p.contextUsagePercentage ?? s.contextUsagePercentage,
          // meteringUsage is emitted per-turn; accumulate into the session total.
          creditsSpent: turnCredits > 0 ? s.creditsSpent + turnCredits : s.creditsSpent,
          lastTurnCredits: turnCredits > 0 ? turnCredits : s.lastTurnCredits,
          lastTurnDurationMs: p.turnDurationMs ?? s.lastTurnDurationMs,
        };
        break;
      }
      case 'subagent_update': {
        this.snapshot = {
          ...s,
          subagents: payload.params.subagents,
          pendingStages: payload.params.pendingStages,
        };
        break;
      }
      case 'mcp_health': {
        const { serverName, error } = payload.params;
        const status: McpServerHealth['status'] = payload.ok ? 'initialized' : 'failed';
        const next = s.mcpServers.filter((m) => m.serverName !== serverName);
        next.push({ serverName, status, error, updatedAt: Date.now() });
        this.snapshot = { ...s, mcpServers: next };
        break;
      }
      case 'commands_available': {
        this.snapshot = { ...s, availableCommands: payload.params.commands };
        break;
      }
      case 'compaction': {
        // 'started' -> compacting; 'completed'/'failed' -> done. Context drops
        // arrive separately via the metadata event.
        this.snapshot = { ...s, compacting: payload.params.status.type === 'started' };
        break;
      }
      case 'oauth_request': {
        const prompts = [
          ...s.oauthPrompts,
          {
            serverName: payload.params.serverName,
            url: payload.params.url,
            createdAt: Date.now(),
          },
        ];
        this.snapshot = { ...s, oauthPrompts: prompts };
        break;
      }
      default:
        break;
    }
    return this.snapshot;
  }

  /** Seed cumulative credits/context from kiro's persisted metadata on resume. */
  seed(creditsSpent: number, contextUsagePercentage: number): void {
    this.snapshot = { ...this.snapshot, creditsSpent, contextUsagePercentage };
  }
}
