import {
  emptyObservabilitySnapshot,
  type CasperEventPayload,
  type ObservabilitySnapshot,
} from '@casper/shared';

/** Folds the event stream into the live snapshot. Pure and deterministic. */
export class TurnState {
  private snapshot: ObservabilitySnapshot = emptyObservabilitySnapshot();

  get(): ObservabilitySnapshot {
    return this.snapshot;
  }

  apply(payload: CasperEventPayload): ObservabilitySnapshot {
    const s = this.snapshot;
    switch (payload.kind) {
      case 'turn_started':
        this.snapshot = { ...s, turnStatus: 'running' };
        break;
      case 'turn_ended':
      case 'turn_error':
        this.snapshot = { ...s, turnStatus: 'idle' };
        break;
      case 'process_exited':
        // Nothing a dead process was doing is still in flight, compaction included: only a
        // completed/failed notification clears that, and while set it disables the composer.
        this.snapshot = { ...s, turnStatus: 'idle', compacting: false };
        break;
      case 'metadata':
        this.snapshot = {
          ...s,
          contextUsagePercentage:
            payload.params.contextUsagePercentage ?? s.contextUsagePercentage,
        };
        break;
      case 'compaction':
        this.snapshot = { ...s, compacting: payload.params.status.type === 'started' };
        break;
      default:
        break;
    }
    return this.snapshot;
  }

  /** Seed context usage from kiro's persisted metadata on resume. */
  seed(contextUsagePercentage: number): void {
    this.snapshot = { ...this.snapshot, contextUsagePercentage };
  }
}
