import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { sha256 } from '../util/hash.js';

/**
 * Writes the casper agent where kiro looks for it. A copy, not a symlink: npm
 * replaces the install directory on upgrade, leaving a link dangling. The recorded
 * hash separates our own older output from the user's edits.
 */
type AgentResult =
  | { action: 'installed' | 'updated' | 'unchanged'; target: string }
  | { action: 'kept-yours' | 'no-source'; target: string };

interface McpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeout: number;
}

/** kiro's agent schema, as far as we set it. */
export interface KiroAgent {
  name: string;
  description: string;
  prompt: string;
  mcpServers: Record<string, McpServer>;
  tools: string[];
  toolAliases: Record<string, string>;
  allowedTools: string[];
  resources: string[];
  hooks: Record<string, unknown>;
  toolsSettings: Record<string, unknown>;
  includeMcpJson: boolean;
  model: string | null;
}

/** Plain text, read rather than imported, so an edit diffs line by line. */
export function agentPrompt(): string | null {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, 'agents/prompt.txt'),
    path.resolve(here, '../../../assets/agents/prompt.txt'),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  return found ? fs.readFileSync(found, 'utf8').trimEnd() : null;
}

function mcpServerPath(): string | null {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, 'mcp.js'),
    path.resolve(here, '../../dist/mcp.js'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** `mcp` is null when there's no build to point at, falling back to the `casper mcp`
 *  command, which won't spawn under a PATH with no npm bin. */
export function agentConfig(prompt: string, mcp: string | null): KiroAgent {
  return {
    name: 'casper',
    description: 'Casper \u2014 an AI assistant you talk to over a web interface.',
    prompt,
    mcpServers: {
      casper: mcp
        ? { command: process.execPath, args: [mcp], env: {}, timeout: 10000 }
        : { command: 'casper', args: ['mcp'], env: {}, timeout: 10000 },
    },
    tools: ['*'],
    toolAliases: {},
    allowedTools: [],
    resources: [],
    hooks: {},
    toolsSettings: {},
    includeMcpJson: true,
    model: null,
  };
}

export function installAgentFile(home: string, dataDir: string): AgentResult {
  const target = path.join(home, '.kiro', 'agents', 'casper.json');
  const prompt = agentPrompt();
  if (prompt === null) return { action: 'no-source', target };

  const desired = `${JSON.stringify(agentConfig(prompt, mcpServerPath()), null, 2)}\n`;
  const stampFile = path.join(dataDir, 'agent-stamp');
  const stamp = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';

  const write = () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, desired);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stampFile, `${sha256(desired)}\n`);
  };

  // lstat, not existsSync: existsSync follows a symlink into a directory npm has
  // replaced, reports false, then writing fails with ENOENT.
  let current: fs.Stats | undefined;
  try {
    current = fs.lstatSync(target);
  } catch {
    current = undefined;
  }

  if (!current) {
    write();
    return { action: 'installed', target };
  }

  if (current.isSymbolicLink()) {
    fs.rmSync(target);
    write();
    return { action: 'updated', target };
  }

  const onDisk = fs.readFileSync(target, 'utf8');
  if (sha256(onDisk) === sha256(desired)) return { action: 'unchanged', target };
  if (stamp !== '' && sha256(onDisk) === stamp) {
    write();
    return { action: 'updated', target };
  }
  return { action: 'kept-yours', target };
}
