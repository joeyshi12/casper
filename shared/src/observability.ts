/** The folded state Casper derives from kiro's `_kiro.dev/*` notifications. */

export type TurnStatus = 'idle' | 'running' | 'cancelling';

export interface ObservabilitySnapshot {
  turnStatus: TurnStatus;
  /** Latest context-window usage percentage (0-100). */
  contextUsagePercentage: number;
  /** True while a /compact is in progress, which disables sending. */
  compacting: boolean;
}

export function emptyObservabilitySnapshot(): ObservabilitySnapshot {
  return { turnStatus: 'idle', contextUsagePercentage: 0, compacting: false };
}
