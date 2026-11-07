// KiroProcess against a stand-in for `kiro-cli acp`: the launch line, the answers it
// gives kiro's own requests, and the V3 methods it calls.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../server/src/config.js';
import { KiroProcess, permissionOutcome } from '../server/src/session/KiroProcess.js';
import { noopLogger } from './helpers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-fake-kiro-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/* Speaks just enough ACP. It logs its argv and every message it receives, advertises the
   extension methods it is told to, and on session/new asks the client two questions of
   its own before answering. */
const FAKE_KIRO = `#!${process.execPath}
const fs = require('node:fs');
const log = (m) => fs.appendFileSync(process.env.FAKE_KIRO_LOG, JSON.stringify(m) + '\\n');
log({ argv: process.argv.slice(2) });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const waiting = new Map();
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    log(m);
    if (m.method === undefined) { waiting.get(m.id)?.(m); continue; }
    handle(m);
  }
});
const ask = (id, method, params) => new Promise((r) => { waiting.set(id, r); send({ id, method, params }); });
async function handle(m) {
  if (m.method === 'initialize') {
    const ext = (process.env.FAKE_KIRO_EXT || '').split(',').filter(Boolean);
    return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { _meta: { kiro: { extensionMethods: ext } } } } });
  }
  if (m.method === 'session/new') {
    const permission = await ask('perm-1', 'session/request_permission', {
      sessionId: 'sess_fake',
      toolCall: { toolCallId: 'run_command_1', title: 'ls' },
      options: [
        { optionId: 'always-accept', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
      ],
    });
    const unknown = await ask('ext-1', '_kiro/openExternalUrl', { url: 'https://example.com' });
    return send({ id: m.id, result: { sessionId: 'sess_fake', modes: { currentModeId: 'vibe', availableModes: [] }, permission, unknown } });
  }
  send({ id: m.id, result: {} });
}
`;

const bin = path.join(dir, 'kiro-cli');
fs.writeFileSync(bin, FAKE_KIRO, { mode: 0o755 });

const logged = (file: string): Record<string, unknown>[] =>
  fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

const spawnFake = (name: string, ext: string) => {
  const log = path.join(dir, `${name}.log`);
  process.env.FAKE_KIRO_LOG = log;
  process.env.FAKE_KIRO_EXT = ext;
  const proc = new KiroProcess({ cwd: dir }, noopLogger());
  return { proc, log };
};

describe('KiroProcess against kiro V3', () => {
  let prevBin: string;
  let proc: KiroProcess;
  let log: string;
  let created: Record<string, unknown>;

  before(async () => {
    prevBin = config.kiroBin;
    (config as { kiroBin: string }).kiroBin = bin;
    ({ proc, log } = spawnFake('main', '_kiro/session/compact,_kiro/session/context'));
    await proc.initialize();
    created = (await proc.newSession({ cwd: dir, mcpServers: [] })) as unknown as Record<string, unknown>;
  });
  after(async () => {
    await proc.disposeAndWait();
    (config as { kiroBin: string }).kiroBin = prevBin;
  });

  it('starts the V3 engine, with none of the launch flags V3 rejects', () => {
    const argv = logged(log)[0]!.argv as string[];
    assert.deepEqual(argv, ['acp', '--agent-engine', 'v3']);
  });

  it('allows a tool once, never always, so no rule is saved outside Casper', () => {
    assert.deepEqual((created.permission as { result: unknown }).result, {
      outcome: { outcome: 'selected', optionId: 'accept' },
    });
  });

  it('answers a request it has no handler for with an error, so kiro does not wait', () => {
    const unknown = created.unknown as { result?: unknown; error?: { code: number } };
    assert.equal(unknown.result, undefined);
    assert.equal(unknown.error?.code, -32601);
  });

  it('sets the model through the advertised config option', async () => {
    await proc.setModel('sess_fake', 'claude-haiku-4.5');
    const sent = logged(log).find((m) => m.method === 'session/set_config_option');
    assert.deepEqual(sent?.params, { sessionId: 'sess_fake', configId: 'model', value: 'claude-haiku-4.5' });
  });

  it("compacts through kiro's advertised method", async () => {
    await proc.compact('sess_fake');
    const sent = logged(log).find((m) => m.method === '_kiro/session/compact');
    assert.deepEqual(sent?.params, { sessionId: 'sess_fake' });
  });

  it('does not call compaction on a kiro that does not advertise it', async () => {
    const other = spawnFake('no-compact', '_kiro/session/context');
    try {
      await other.proc.initialize();
      await assert.rejects(() => other.proc.compact('sess_fake'), /does not offer compaction/);
      assert.equal(logged(other.log).some((m) => m.method === '_kiro/session/compact'), false);
    } finally {
      await other.proc.disposeAndWait();
    }
  });
});

describe('permissionOutcome', () => {
  it('rejects once when kiro offers no way to allow once', () => {
    assert.deepEqual(
      permissionOutcome({
        sessionId: 's',
        options: [
          { optionId: 'always', kind: 'allow_always' },
          { optionId: 'no', kind: 'reject_once' },
        ],
      }),
      { outcome: { outcome: 'selected', optionId: 'no' } },
    );
  });

  it('cancels when kiro offers nothing it can pick', () => {
    assert.deepEqual(permissionOutcome({ sessionId: 's', options: [] }), { outcome: { outcome: 'cancelled' } });
    assert.deepEqual(permissionOutcome(undefined), { outcome: { outcome: 'cancelled' } });
  });
});
