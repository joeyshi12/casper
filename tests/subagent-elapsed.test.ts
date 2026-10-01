import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed } from '../web/src/util/duration.js';

describe('subagent elapsed time', () => {
  it('a finished subagent counts up to its last update, not up to now', async () => {
    const { elapsedSeconds } = await import('../web/src/components/chat/SubagentToolCall.js');
    const s = elapsedSeconds({
      status: 'completed',
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-01T12:00:48.000Z',
    });
    assert.equal(s, 48);
  });

  it('formats hours once past an hour', () => {
    assert.equal(formatElapsed(48), '48s');
    assert.equal(formatElapsed(83), '1m 23s');
    assert.equal(formatElapsed(7500), '2h 5m');
  });
});
