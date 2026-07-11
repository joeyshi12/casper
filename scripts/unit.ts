// Unit checks for the pure fold logic (no processes or network).
// Run with: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CasperEventPayload } from '@casper/shared';
import { TurnState } from '../server/src/session/TurnState.js';
import {
  confineToRoot,
  isValidSessionId,
  isWithinRoot,
  realConfineToRoot,
} from '../server/src/util/paths.js';
import { classifyKind } from '../server/src/util/filekind.js';

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

// Path confinement (security-critical: bounds all file-serving endpoints).
check(isWithinRoot('/home/joey', '/home/joey/a/b'), 'isWithinRoot: nested path allowed');
check(isWithinRoot('/home/joey', '/home/joey'), 'isWithinRoot: root itself allowed');
check(!isWithinRoot('/home/joey', '/home/joeyx/x'), 'isWithinRoot: prefix-match blocked');
check(isWithinRoot('/', '/etc/passwd'), 'isWithinRoot: fs root contains everything');
check(confineToRoot('/home/joey', 'a/b') === '/home/joey/a/b', 'confineToRoot: relative resolved');
check(confineToRoot('/home/joey', '../etc') === null, 'confineToRoot: traversal blocked');
check(confineToRoot('/home/joey', '/etc/passwd') === null, 'confineToRoot: out-of-root absolute blocked');
check(isValidSessionId('ec0afd54-d34c-4da8-ac92-051841321930'), 'isValidSessionId: uuid accepted');
check(!isValidSessionId('../../etc/passwd'), 'isValidSessionId: traversal rejected');
check(!isValidSessionId('a/b'), 'isValidSessionId: separator rejected');
check(!isValidSessionId('.'), 'isValidSessionId: dot rejected');

// Upload classification decides how a file is surfaced to the agent.
check(classifyKind('photo.PNG') === 'image', 'classifyKind: image by extension (case-insensitive)');
check(classifyKind('notes.md') === 'text', 'classifyKind: markdown is text');
check(classifyKind('main.rs') === 'text', 'classifyKind: source code is text');
check(classifyKind('sample.exe') === 'binary', 'classifyKind: exe is binary');
check(classifyKind('archive.tar.gz') === 'binary', 'classifyKind: gzip is binary');
check(classifyKind('noext') === 'binary', 'classifyKind: no extension defaults to binary');

// realConfineToRoot resolves symlinks: a link inside the root pointing out is rejected.
async function realpathTests(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-out-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
    fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const escaped = await realConfineToRoot(root, path.join(root, 'escape', 'secret.txt'));
    check(escaped === null, 'realConfineToRoot: symlink escaping root rejected');
    const inRoot = await realConfineToRoot(root, path.join(root, 'ok.txt'));
    check(inRoot !== null, 'realConfineToRoot: in-root file allowed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

void realpathTests().then(() => {
  if (failures > 0) {
    console.error(`\n❌ ${failures} unit check(s) failed.`);
    process.exit(1);
  }
  console.log('\n🎉 Unit checks passed.');
});
