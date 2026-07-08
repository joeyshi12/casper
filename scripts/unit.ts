// Unit checks for the pure fold logic (no processes or network).
// Run with: npm test
import type { CasperEventPayload } from '@casper/shared';
import { TurnState } from '../server/src/session/TurnState.js';

let failures = 0;
function check(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`✅ ${msg}`);
  } else {
    console.error(`❌ ${msg}`);
    failures++;
  }
}

// A representative stream of events across one full turn.
const events: CasperEventPayload[] = [
  { kind: 'commands_available', params: { sessionId: 's', commands: [{ name: '/agent' }] } },
  { kind: 'mcp_health', params: { sessionId: 's', serverName: 'builder-mcp' }, ok: true },
  { kind: 'mcp_health', params: { sessionId: 's', serverName: 'pippin-mcp', error: 'boom' }, ok: false },
  { kind: 'turn_started', prompt: [{ type: 'text', text: 'hi' }] },
  { kind: 'session_update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } },
  { kind: 'metadata', params: { sessionId: 's', contextUsagePercentage: 15.9, meteringUsage: [{ value: 0.04, unit: 'credit', unitPlural: 'credits' }], turnDurationMs: 1916 } },
  { kind: 'turn_ended', stopReason: 'end_turn' },
  // A second turn adds more credits.
  { kind: 'turn_started', prompt: [{ type: 'text', text: 'again' }] },
  { kind: 'metadata', params: { sessionId: 's', contextUsagePercentage: 22.1, meteringUsage: [{ value: 0.06, unit: 'credit', unitPlural: 'credits' }], turnDurationMs: 3000 } },
  { kind: 'turn_ended', stopReason: 'end_turn' },
];

const ts = new TurnState();
for (const e of events) ts.apply(e);
const snap = ts.get();

check(Math.abs(snap.creditsSpent - 0.1) < 1e-9, `cumulative credits accumulate across turns (${snap.creditsSpent.toFixed(4)})`);
check(Math.abs(snap.lastTurnCredits - 0.06) < 1e-9, `lastTurnCredits reflects most recent turn (${snap.lastTurnCredits})`);
check(snap.contextUsagePercentage === 22.1, `contextUsagePercentage takes latest value (${snap.contextUsagePercentage})`);
check(snap.lastTurnDurationMs === 3000, `lastTurnDurationMs takes latest value (${snap.lastTurnDurationMs})`);
check(snap.turnStatus === 'idle', 'turnStatus returns to idle after turn_ended');
check(snap.mcpServers.length === 2, 'both MCP servers tracked');
check(snap.mcpServers.find((m) => m.serverName === 'pippin-mcp')?.status === 'failed', 'failed MCP server marked failed');
check(snap.mcpServers.find((m) => m.serverName === 'builder-mcp')?.status === 'initialized', 'healthy MCP server marked initialized');
check(snap.availableCommands.length === 1, 'available commands captured');

// Seed (resume path) should set cumulative baseline.
const ts2 = new TurnState();
ts2.seed(1.5, 40);
check(ts2.get().creditsSpent === 1.5, 'seed sets cumulative credits on resume');
check(ts2.get().contextUsagePercentage === 40, 'seed sets context usage on resume');

if (failures > 0) {
  console.error(`\n❌ ${failures} unit check(s) failed.`);
  process.exit(1);
}
console.log('\n🎉 Unit checks passed.');
