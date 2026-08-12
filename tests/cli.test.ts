// The CLI: argument validation, the settings and agent files, and doctor.
// Run with: npm test

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, parseConfigDoc, pickInt, pickString } from '../server/src/config.js';
import { readSettings, updateSettings } from '../server/src/cli/settings.js';
import { configFilePath, dataDirPath } from '../server/src/paths.js';
import { installAgentFile } from '../server/src/cli/agentFile.js';
import { mcpWiring } from '../server/src/cli/doctor.js';
import type { Command } from 'commander';
import { buildProgram } from '../server/src/cli/program.js';
import { handleMessage, DEFAULT_PROTOCOL_VERSION } from '../server/src/mcp/protocol.js';

describe('cli argument validation', () => {
  // `casper reset-token --dry-run` used to adopt "--dry-run" as the new token and
  // revoke every session - the destructive act the flag was meant to avoid.
  function parse(args: string[]): string | undefined {
    const program = buildProgram();
    // Neither override propagates to subcommands, and without them a subcommand error
    // calls process.exit and takes the test runner down with it.
    const quiet = (cmd: Command): void => {
      cmd.exitOverride();
      cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      cmd.commands.forEach(quiet);
    };
    quiet(program);
    try {
      program.parse(['node', 'casper', ...args]);
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  }

  it('rejects an unknown option instead of treating it as a value', () => {
    assert.match(String(parse(['reset-token', '--dry-run'])), /unknown option/);
  });

  it('rejects unknown options on commands that take none', () => {
    assert.match(String(parse(['token', '--json'])), /unknown option/);
  });

  it('rejects extra positional arguments', () => {
    assert.match(String(parse(['reset-token', 'a', 'b'])), /too many arguments/);
  });

  it('rejects an unknown command', () => {
    assert.match(String(parse(['frobnicate'])), /unknown command/);
  });

  it('rejects an unknown service subcommand', () => {
    assert.match(String(parse(['service', 'bogus'])), /unknown command/);
  });

  it('declares every command the help promises', () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .sort();
    assert.deepEqual(names, ['doctor', 'mcp', 'reset-token', 'service', 'start', 'token']);
  });

  it('exposes the mcp server as a command, so it can be wired in by hand', () => {
    const names = buildProgram().commands.map((c) => c.name());
    assert.ok(names.includes('mcp'), names.join(', '));
    // Anything on stdout corrupts the protocol stream, so this one must not bootstrap.
    assert.equal(
      parse(['mcp', 'extra']),
      "error: too many arguments for 'mcp'. Expected 0 arguments but got 1: extra.",
    );
  });
});

describe('cli settings file', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-set-'));
    file = path.join(dir, 'config.json');
  });

  it('merges into the existing file instead of replacing it', () => {
    fs.writeFileSync(file, JSON.stringify({ port: 4319, defaultAgent: 'casper' }));
    updateSettings(file, { token: 'abc' });
    assert.deepEqual(readSettings(file), { port: 4319, defaultAgent: 'casper', token: 'abc' });
  });

  it('writes 0600, since the file holds the token', () => {
    updateSettings(file, { token: 'abc' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('creates the directory when it is missing', () => {
    const nested = path.join(dir, 'a', 'b', 'config.json');
    updateSettings(nested, { token: 'abc' });
    assert.equal(readSettings(nested).token, 'abc');
  });

  it('leaves no temp file behind', () => {
    updateSettings(file, { token: 'abc' });
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.includes('tmp')),
      [],
    );
  });

  it('treats a malformed or non-object file as empty rather than throwing', () => {
    fs.writeFileSync(file, 'not json at all');
    assert.deepEqual(readSettings(file), {});
    fs.writeFileSync(file, '[1,2,3]');
    assert.deepEqual(readSettings(file), {});
  });
});

describe('cli agent file', () => {
  let home: string;
  let data: string;
  let target: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-home-'));
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-agentdata-'));
    target = path.join(home, '.kiro', 'agents', 'casper.json');
  });

  it('installs a real file, not a symlink - npm would leave a link dangling', () => {
    const r = installAgentFile(home, data);
    assert.equal(r.action, 'installed');
    assert.ok(fs.existsSync(target));
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  });

  it('is a no-op on the second run', () => {
    installAgentFile(home, data);
    assert.equal(installAgentFile(home, data).action, 'unchanged');
  });

  it('keeps a file the user edited', () => {
    installAgentFile(home, data);
    fs.writeFileSync(target, '{"name":"casper","description":"mine"}');
    assert.equal(installAgentFile(home, data).action, 'kept-yours');
    assert.match(fs.readFileSync(target, 'utf8'), /mine/);
  });

  it('refreshes an unmodified copy when the shipped file changes', () => {
    installAgentFile(home, data);
    // Same effect as a new version shipping: the stamp no longer matches the file
    // we would write, but it does match what is on disk.
    const stamp = path.join(data, 'agent-stamp');
    fs.writeFileSync(target, 'superseded contents');
    fs.writeFileSync(
      stamp,
      `${crypto.createHash('sha256').update('superseded contents').digest('hex')}\n`,
    );
    assert.equal(installAgentFile(home, data).action, 'updated');
    assert.notEqual(fs.readFileSync(target, 'utf8'), 'superseded contents');
  });

  it('replaces a symlink left by the old shell installer', () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync('/nonexistent/casper.json', target);
    assert.equal(installAgentFile(home, data).action, 'updated');
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  });
});

describe('config file precedence', () => {
  it('takes a value from the file when the env var is absent', () => {
    assert.equal(pickString(undefined, 'from-file', 'default'), 'from-file');
    assert.equal(pickInt(undefined, 9999, 4319), 9999);
  });

  it('lets the environment override the file', () => {
    assert.equal(pickString('from-env', 'from-file', 'default'), 'from-env');
    assert.equal(pickInt('1234', 9999, 4319), 1234);
  });

  it('treats an empty env var as unset, so the file still applies', () => {
    assert.equal(pickString('', 'from-file', 'default'), 'from-file');
    assert.equal(pickInt('', 9999, 4319), 9999);
  });

  it('falls back to the default when neither is present', () => {
    assert.equal(pickString(undefined, undefined, 'default'), 'default');
    assert.equal(pickInt(undefined, undefined, 4319), 4319);
  });

  it('accepts a numeric setting written as a JSON string', () => {
    assert.equal(pickInt(undefined, '8080', 4319), 8080);
  });

  it('ignores a file value of the wrong type', () => {
    assert.equal(pickString(undefined, 42, 'default'), 'default');
    assert.equal(pickInt(undefined, 'not a number', 4319), 4319);
    assert.equal(pickInt(undefined, {}, 4319), 4319);
  });

  it('parses an object of settings', () => {
    assert.deepEqual(parseConfigDoc('{"port":9999}'), { port: 9999 });
  });

  it('yields nothing for malformed JSON rather than throwing', () => {
    const warnings: string[] = [];
    assert.deepEqual(parseConfigDoc('not json', (m) => warnings.push(m)), {});
    assert.match(warnings[0] ?? '', /invalid JSON/);
  });

  it('rejects a JSON array, which is the wrong shape', () => {
    const warnings: string[] = [];
    assert.deepEqual(parseConfigDoc('[1,2,3]', (m) => warnings.push(m)), {});
    assert.match(warnings[0] ?? '', /expected a JSON object/);
  });

  it('keeps known keys and reports a typo alongside them', () => {
    const warnings: string[] = [];
    const doc = parseConfigDoc('{"prot":1111,"host":"127.0.0.1"}', (m) => warnings.push(m));
    assert.equal(doc.host, '127.0.0.1');
    assert.match(warnings[0] ?? '', /unrecognised keys/);
  });

  it('points at the settings file it reads, for diagnostics', () => {
    assert.match(config.configFile, /casper\/config\.json$/);
  });
});

describe('pre-settings paths', () => {
  // bootstrap writes the first-run token through these helpers, while the server
  // reads it through config. If they ever disagree the token lands somewhere the
  // server doesn't look, and it starts with authentication silently disabled -
  // which is exactly the bug this pairing fixed.
  it('resolves the same settings file the config reads', () => {
    assert.equal(configFilePath(), config.configFile);
  });

  it('resolves the same data directory the config reads', () => {
    assert.equal(dataDirPath(), config.casperDataDir);
  });

  it('honours XDG_CONFIG_HOME', () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-probe';
    try {
      assert.equal(configFilePath(), '/tmp/xdg-probe/casper/config.json');
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });

  it('treats a blank XDG_CONFIG_HOME as unset rather than resolving from nothing', () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '   ';
    try {
      assert.match(configFilePath(), /\/\.config\/casper\/config\.json$/);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });
});

describe('doctor: casper mcp', () => {
  // The recorded path can outlive its install: npm replaces the directory on upgrade,
  // and a hand-edited agent file stops being rewritten.
  const resolves = (bin: string) => (bin === '/usr/bin/node' || bin === 'casper' ? bin : undefined);
  const agent = (server: unknown) => JSON.stringify({ mcpServers: server ? { casper: server } : {} });

  it('passes when the script it names is really there', () => {
    // A real file, made here: pointing at a build artifact made this pass locally and
    // fail in CI, which runs the tests without building first.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casper-mcp-'));
    const script = path.join(dir, 'mcp.js');
    fs.writeFileSync(script, '');
    try {
      const r = mcpWiring(agent({ command: '/usr/bin/node', args: [script] }), resolves);
      assert.equal(r.ok, true);
      assert.equal(r.detail, script);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says what to do when the path is stale', () => {
    const r = mcpWiring(agent({ command: '/usr/bin/node', args: ['/gone/dist/mcp.js'] }), resolves);
    assert.equal(r.ok, false);
    assert.match(r.detail, /is gone - delete the agent file/);
  });

  it('accepts a hand-copied config that goes through the CLI', () => {
    const r = mcpWiring(agent({ command: 'casper', args: ['mcp'] }), resolves);
    assert.equal(r.ok, true);
    assert.match(r.detail, /casper mcp/);
  });

  it('warns when the tools are not wired at all', () => {
    assert.match(mcpWiring(agent(null), resolves).detail, /not declared/);
  });

  it('warns when the command is missing rather than claiming health', () => {
    const r = mcpWiring(agent({ command: '/nope/node', args: ['x.js'] }), resolves);
    assert.equal(r.ok, false);
    assert.match(r.detail, /not found/);
  });

  it('survives an agent file that is not JSON', () => {
    assert.equal(mcpWiring('{oops', resolves).ok, false);
  });
});

describe('shipped agent file', () => {
  const agent = JSON.parse(
    fs.readFileSync('assets/agents/casper.json', 'utf8'),
  ) as { mcpServers: Record<string, { command: string; args: string[] }>; prompt: string };

  // It shipped with mcpServers empty, relying on the installer to fill it in, which
  // left the file unable to describe itself and a hand copy without widget tools.
  it('names the widget server, so the file stands on its own', () => {
    const server = agent.mcpServers.casper;
    assert.ok(server, 'no casper server declared');
    assert.equal(server.command, 'casper');
    assert.deepEqual(server.args, ['mcp']);
  });

  it('only promises tools the server actually has', () => {
    const res = handleMessage({ id: 1, method: 'tools/list' }, '0');
    const names = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    for (const match of agent.prompt.match(/\bshow_[a-z_]+/g) ?? []) {
      assert.ok(names.includes(match), `prompt names ${match}, which no tool provides`);
    }
  });
});
