// The settings routes: the defaults a new chat gets, written to kiro's settings through a
// fake kiro-cli that keeps them in a file, and the server's own setup.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SettingsResponse } from '@casper/shared';
import { config } from '../server/src/config.js';
import { closeDb } from '../server/src/session/db.js';
import { invalidateAgents } from '../server/src/session/agents.js';
import { rememberKiroModels } from '../server/src/session/kiroModels.js';
import { invalidateModels, listModels } from '../server/src/session/models.js';
import { configuredDefaultAgent } from '../server/src/session/kiroTools.js';
import { registerSettingsRoutes } from '../server/src/routes/settings.js';
import type { SessionManager } from '../server/src/session/SessionManager.js';
import { noopLogger } from './helpers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-settings-'));
const settingsFile = path.join(dir, 'kiro-settings.json');
const bin = path.join(dir, 'kiro-cli');
const prev = { kiroBin: config.kiroBin, casperDataDir: config.casperDataDir, token: config.token, kiroSessionsDir: config.kiroSessionsDir };
const kiroDir = path.join(dir, 'kiro');

// `settings <key> -f json` prints a value, `settings <key> <value>` stores one, and
// `chat --list-models` prints the model list. `agent list` prints no agents.
fs.writeFileSync(
  bin,
  `#!/usr/bin/env node
const fs = require('fs');
const file = ${JSON.stringify(settingsFile)};
const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const [cmd, key, value] = process.argv.slice(2);
if (cmd === 'chat') {
  const m = (id) => ({ model_id: id, model_name: id, description: '', context_window_tokens: 1, rate_multiplier: 1, rate_unit: 'Credit' });
  console.log(JSON.stringify({ models: [m('auto'), m('claude-opus-5.5'), m('gpt-5.6-sol')], default_model: 'auto' }));
} else if (cmd === 'settings' && value === '-f') {
  console.log(JSON.stringify(all[key] ?? null));
} else if (cmd === 'settings') {
  let v = value;
  try { v = JSON.parse(value); } catch {}
  all[key] = v;
  fs.writeFileSync(file, JSON.stringify(all));
}
`,
  { mode: 0o755 },
);

let app: FastifyInstance;

before(async () => {
  Object.assign(config, { kiroBin: bin, casperDataDir: path.join(dir, 'data'), token: 'secret-token', kiroSessionsDir: path.join(kiroDir, 'sessions') });
  closeDb();
  fs.writeFileSync(settingsFile, JSON.stringify({ 'chat.modelDefaults': { 'gpt-5.6-sol': { reasoning: { effort: 'low', summary: 'auto' } } } }));
  rememberKiroModels([
    {
      id: 'model',
      options: [
        { value: 'claude-opus-5.5', _meta: { kiro: { effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffortLevel: 'medium', effortSchemaPath: 'output_config' } } },
        { value: 'gpt-5.6-sol', _meta: { kiro: { effortLevels: ['none', 'low', 'medium', 'high'], effortSchemaPath: 'reasoning' } } },
      ],
    },
  ]);
  invalidateModels();
  invalidateAgents();
  app = Fastify();
  registerSettingsRoutes(app, { liveCount: 1 } as unknown as SessionManager, Date.now() - 65_000);
  await app.ready();
});

after(async () => {
  await app.close();
  closeDb();
  Object.assign(config, prev);
  invalidateModels();
  invalidateAgents();
  fs.rmSync(dir, { recursive: true, force: true });
});

const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/settings/defaults', payload: payload as object });
const kiroSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;

describe('the settings routes', () => {
  it("reports the server's setup, and never the token", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = res.json() as SettingsResponse;
    assert.equal(body.server.kiroBin, bin);
    assert.equal(body.server.authEnabled, true);
    assert.equal(body.server.liveSessions, 1);
    assert.ok(body.server.uptimeMs >= 65_000);
    assert.equal(res.body.includes('secret-token'), false);
  });

  it("writes the default model to kiro's settings, and the list follows", async () => {
    assert.equal((await put({ modelId: 'claude-opus-5.5' })).statusCode, 200);
    assert.equal(kiroSettings()['chat.defaultModel'], 'claude-opus-5.5');
    assert.equal((await listModels(noopLogger())).find((m) => m.isDefault)?.modelId, 'claude-opus-5.5');
    assert.equal((await put({ modelId: 'not-a-model' })).statusCode, 400);
    assert.equal(kiroSettings()['chat.defaultModel'], 'claude-opus-5.5');
  });

  it('writes an effort under the section kiro names, and keeps what else an entry has', async () => {
    assert.equal((await put({ effort: { modelId: 'claude-opus-5.5', level: 'xhigh' } })).statusCode, 200);
    assert.equal((await put({ effort: { modelId: 'gpt-5.6-sol', level: 'high' } })).statusCode, 200);
    assert.deepEqual(kiroSettings()['chat.modelDefaults'], {
      'gpt-5.6-sol': { reasoning: { effort: 'high', summary: 'auto' } },
      'claude-opus-5.5': { output_config: { effort: 'xhigh' } },
    });
    assert.equal((await listModels(noopLogger())).find((m) => m.modelId === 'claude-opus-5.5')?.defaultEffort, 'xhigh');
    assert.equal((await put({ effort: { modelId: 'claude-opus-5.5', level: 'none' } })).statusCode, 400, 'a level the model lacks');
    assert.equal((await put({ effort: { modelId: 'auto', level: 'low' } })).statusCode, 400, 'a model with no levels');
  });

  it("writes the default agent to kiro's chat.defaultAgent, from the agents kiro has", async () => {
    assert.equal(await configuredDefaultAgent(), undefined);
    assert.equal((await put({ agentId: 'vibe' })).statusCode, 200);
    assert.equal(kiroSettings()['chat.defaultAgent'], 'vibe');
    assert.equal(await configuredDefaultAgent(), 'vibe');
    assert.equal((await put({ agentId: 'no-such-agent' })).statusCode, 400);
    assert.equal(kiroSettings()['chat.defaultAgent'], 'vibe');
    assert.equal(((await app.inject({ method: 'GET', url: '/api/settings' })).json() as SettingsResponse).defaultAgentId, 'vibe');
  });
});

describe('the tools routes', () => {
  const mcpFile = path.join(kiroDir, 'settings', 'mcp.json');
  const tools = async () => (await app.inject({ method: 'GET', url: '/api/tools' })).json() as import('@casper/shared').ToolsResponse;

  it('lists the MCP servers without their environment values, and keeps what it does not know', async () => {
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: { figma: { command: 'npx', args: ['-y', 'figma'], env: { FIGMA_API_KEY: 'figd_secret' }, timeout: 120000 } }, other: 1 }),
      { mode: 0o600 },
    );
    const res = await app.inject({ method: 'GET', url: '/api/tools' });
    assert.equal(res.body.includes('figd_secret'), false, 'a key never reaches the page');
    assert.deepEqual((await tools()).mcpServers, [
      { name: 'figma', command: 'npx', args: ['-y', 'figma'], envKeys: ['FIGMA_API_KEY'], disabled: false },
    ]);

    assert.equal((await app.inject({ method: 'PUT', url: '/api/tools/mcp/figma', payload: { disabled: true } })).statusCode, 200);
    const saved = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
    assert.deepEqual(saved.mcpServers.figma, { command: 'npx', args: ['-y', 'figma'], env: { FIGMA_API_KEY: 'figd_secret' }, timeout: 120000, disabled: true });
    assert.equal(saved.other, 1);
    assert.equal(fs.statSync(mcpFile).mode & 0o777, 0o600, 'the file stays private');
    await app.inject({ method: 'PUT', url: '/api/tools/mcp/figma', payload: { disabled: false } });
    assert.equal('disabled' in JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers.figma, false);
  });

  it('adds a server that runs a command or one at a URL, and removes one', async () => {
    const add = (payload: object) => app.inject({ method: 'POST', url: '/api/tools/mcp', payload });
    assert.equal((await add({ name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], env: { A: '1' } })).statusCode, 200);
    assert.equal((await add({ name: 'remote', url: 'https://example.test/mcp' })).statusCode, 200);
    for (const bad of [
      { name: 'fetch', command: 'x' },
      { name: 'bad name', command: 'x' },
      { name: 'both', command: 'x', url: 'https://a.test' },
      { name: 'neither' },
      { name: 'ftp', url: 'ftp://a.test' },
      { name: 'env', command: 'x', env: { 'NOT OK': '1' } },
    ]) {
      assert.equal((await add(bad)).statusCode, 400, JSON.stringify(bad));
    }
    const servers = JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers;
    assert.deepEqual(servers.fetch, { command: 'uvx', args: ['mcp-server-fetch'], env: { A: '1' } });
    assert.deepEqual(servers.remote, { url: 'https://example.test/mcp' });
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/tools/mcp/remote' })).statusCode, 200);
    assert.deepEqual((await tools()).mcpServers.map((m) => m.name), ['figma', 'fetch']);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/tools/mcp/remote' })).statusCode, 400);
  });

  it('lists the skills from their SKILL.md front matter', async () => {
    const skill = (name: string, body: string) => {
      fs.mkdirSync(path.join(kiroDir, 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(kiroDir, 'skills', name, 'SKILL.md'), body);
    };
    skill('grilling', '---\nname: grilling\ndescription: "Grill the user about a plan."\n---\n# Grilling\n');
    skill('plain', '# No front matter\n');
    fs.mkdirSync(path.join(kiroDir, 'skills', 'empty'), { recursive: true });
    assert.deepEqual((await tools()).skills, [
      { name: 'grilling', description: 'Grill the user about a plan.', path: path.join(kiroDir, 'skills', 'grilling', 'SKILL.md') },
      { name: 'plain', description: '', path: path.join(kiroDir, 'skills', 'plain', 'SKILL.md') },
    ]);
  });
});
