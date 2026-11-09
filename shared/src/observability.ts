import type { ContextBreakdown } from './acp.js';

/** The folded state Casper derives from kiro's context-usage and compaction events. */

export type TurnStatus = 'idle' | 'running' | 'cancelling';

export interface ObservabilitySnapshot {
  turnStatus: TurnStatus;
  /** Latest context-window usage percentage (0-100). */
  contextUsagePercentage: number;
  /** What the used context holds. Known once kiro has reported it for the live session. */
  contextBreakdown?: ContextBreakdown;
  /** Credits the session has used. Known once kiro has reported it for the live session. */
  sessionCredits?: number;
  /** True while a /compact is in progress, which disables sending. */
  compacting: boolean;
}

export function emptyObservabilitySnapshot(): ObservabilitySnapshot {
  return { turnStatus: 'idle', contextUsagePercentage: 0, compacting: false };
}
