import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { McpServerInfo, McpServerInput, SkillInfo } from '@casper/shared';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/** kiro's own directory, the parent of its session store: `~/.kiro` unless moved. */
function kiroHome(): string {
  return path.dirname(config.kiroSessionsDir);
}

const mcpFile = () => path.join(kiroHome(), 'settings', 'mcp.json');

async function readSetting(key: string): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(config.kiroBin, ['settings', key, '-f', 'json']);
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined; // unset, or a kiro without the key
  }
}

async function writeSetting(key: string, value: string): Promise<void> {
  await execFileAsync(config.kiroBin, ['settings', key, value]);
}

// The default agent is read on every new chat, so it is kept for a short while.
let agentCache: { at: number; value: string | undefined } | null = null;

/** The agent kiro's `chat.defaultAgent` names, or undefined when it names none. */
export async function configuredDefaultAgent(): Promise<string | undefined> {
  if (agentCache && Date.now() - agentCache.at < 30_000) return agentCache.value;
  const value = await readSetting('chat.defaultAgent');
  agentCache = { at: Date.now(), value: typeof value === 'string' && value ? value : undefined };
  return agentCache.value;
}

export async function setDefaultAgent(agentId: string): Promise<void> {
  await writeSetting('chat.defaultAgent', agentId);
  agentCache = null;
}

type McpFile = { mcpServers?: Record<string, Record<string, unknown>>; [key: string]: unknown };

async function readMcp(): Promise<McpFile> {
  try {
    const value = JSON.parse(await fs.readFile(mcpFile(), 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as McpFile) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not read ${mcpFile()}: ${(err as Error).message}`);
  }
}

/** Writes the file whole through a temporary copy, keeping its permissions: it holds the
 *  servers' environment, which is often where their keys are. */
async function writeMcp(data: McpFile): Promise<void> {
  const file = mcpFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const mode = await fs.stat(file).then((s) => s.mode & 0o777, () => 0o600);
  const tmp = `${file}.casper-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  await fs.rename(tmp, file);
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The servers in kiro's global `mcp.json`. Environment values are left out: only their
 *  names are shown. */
export async function listMcpServers(): Promise<McpServerInfo[]> {
  const servers = (await readMcp()).mcpServers ?? {};
  return Object.entries(servers).map(([name, s]) => ({
    name,
    ...(typeof s.command === 'string' ? { command: s.command } : {}),
    ...(typeof s.url === 'string' ? { url: s.url } : {}),
    args: strings(s.args),
    envKeys: s.env && typeof s.env === 'object' ? Object.keys(s.env) : [],
    disabled: s.disabled === true,
  }));
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export async function addMcpServer(input: McpServerInput): Promise<void> {
  const name = String(input.name ?? '').trim();
  if (!SERVER_NAME.test(name)) throw new Error('A name is letters, digits, dots, dashes and underscores');
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!!command === !!url) throw new Error('Give either a command or a URL');
  if (url && !/^https?:\/\//.test(url)) throw new Error('The URL must start with http:// or https://');
  const args = strings(input.args);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string') throw new Error(`Bad environment variable: ${k}`);
    env[k] = v;
  }
  const data = await readMcp();
  const servers = { ...(data.mcpServers ?? {}) };
  if (servers[name]) throw new Error(`A server named ${name} already exists`);
  servers[name] = { ...(url ? { url } : { command, args }), ...(Object.keys(env).length ? { env } : {}) };
  await writeMcp({ ...data, mcpServers: servers });
}

/** Turns a server on or off. Every other key of its entry is kept. */
export async function setMcpServerDisabled(name: string, disabled: boolean): Promise<void> {
  const data = await readMcp();
  const entry = data.mcpServers?.[name];
  if (!entry) throw new Error(`No server named ${name}`);
  const next = { ...entry };
  if (disabled) next.disabled = true;
  else delete next.disabled;
  await writeMcp({ ...data, mcpServers: { ...data.mcpServers, [name]: next } });
}

export async function removeMcpServer(name: string): Promise<void> {
  const data = await readMcp();
  if (!data.mcpServers?.[name]) throw new Error(`No server named ${name}`);
  const { [name]: _removed, ...rest } = data.mcpServers;
  await writeMcp({ ...data, mcpServers: rest });
}

/** The `name` and `description` lines of a SKILL.md's front matter. */
function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  for (const line of m?.[1]?.split(/\r?\n/) ?? []) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/** The skills in `~/.kiro/skills`, each a folder with a SKILL.md. */
export async function listSkills(): Promise<SkillInfo[]> {
  const dir = path.join(kiroHome(), 'skills');
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of entries.sort()) {
    const file = path.join(dir, name, 'SKILL.md');
    try {
      const meta = frontMatter(await fs.readFile(file, 'utf8'));
      out.push({ name: meta.name || name, description: meta.description ?? '', path: file });
    } catch {
      /* a folder without a SKILL.md is no skill */
    }
  }
  return out;
}
