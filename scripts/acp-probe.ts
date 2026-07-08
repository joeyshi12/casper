// Drives a KiroProcess directly (no HTTP) and asserts the ACP protocol
// behavior. Useful as a regression check after a kiro-cli version bump.
// Run with: npm run probe
import {
  KIRO_NOTIFICATIONS,
  type KiroMetadataParams,
  type SessionUpdateParams,
} from '@casper/shared';
import { KiroProcess } from '../server/src/session/KiroProcess.js';
import { config } from '../server/src/config.js';
import { logger } from '../server/src/util/logger.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`\n❌ ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ ${msg}`);
}

async function main() {
  const proc = new KiroProcess({ cwd: config.defaultCwd }, logger);

  let sawChunk = false;
  let sawMetering = false;
  let chunkText = '';

  proc.on('notification', (n) => {
    if (n.method === 'session/update') {
      const p = n.params as SessionUpdateParams;
      if (p.update?.sessionUpdate === 'agent_message_chunk') {
        sawChunk = true;
        const content = (p.update as { content?: { text?: string } }).content;
        if (content?.text) chunkText += content.text;
      }
    }
    if (n.method === KIRO_NOTIFICATIONS.metadata) {
      const p = n.params as KiroMetadataParams;
      if (p.meteringUsage && p.meteringUsage.length > 0) {
        sawMetering = true;
        console.log(
          `   metering: ${p.meteringUsage[0]!.value} ${p.meteringUsage[0]!.unitPlural}, ` +
            `context ${p.contextUsagePercentage?.toFixed(1)}%, ${p.turnDurationMs}ms`,
        );
      }
    }
  });

  console.log('→ initialize');
  const init = await proc.initialize();
  assert(init.protocolVersion === 1, 'initialize returned protocolVersion 1');
  assert(init.agentCapabilities.loadSession === true, 'agent advertises loadSession');
  console.log(`   agent: ${init.agentInfo.name} v${init.agentInfo.version}`);

  console.log('→ session/new');
  const session = await proc.newSession({ cwd: config.defaultCwd, mcpServers: [] });
  assert(typeof session.sessionId === 'string', 'session/new returned a sessionId');
  assert(
    Array.isArray(session.modes.availableModes) && session.modes.availableModes.length > 0,
    `session/new returned availableModes (${session.modes.availableModes.length} agents)`,
  );
  console.log(
    `   modes: ${session.modes.availableModes.map((m) => m.id).join(', ')} (current: ${session.modes.currentModeId})`,
  );

  console.log('→ session/prompt "reply PONG"');
  const result = await proc.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly one word: PONG' }],
  });
  assert(result.stopReason === 'end_turn', `prompt ended with stopReason=${result.stopReason}`);
  assert(sawChunk, `received agent_message_chunk (text: ${JSON.stringify(chunkText.trim())})`);
  assert(sawMetering, 'received _kiro.dev/metadata with meteringUsage');

  console.log('\n🎉 ACP bridge probe passed.');
  proc.dispose();
  setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
  console.error('\n❌ Probe error:', err);
  process.exit(1);
});
