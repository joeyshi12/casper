import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/**
 * Write the casper agent where kiro looks for it, so `--agent casper` resolves from any
 * working directory. A copy, not a symlink: npm replaces the install directory on
 * upgrade and deletes it on removal, leaving a link dangling. The recorded hash
 * separates our own older output from the user's edits.
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

/**
 * Markdown on disk, so a prompt edit diffs line by line. Read rather than imported:
 * tsx hands a .md import to the JS parser.
 */
export function agentPrompt(): string | null {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, 'agents/prompt.md'), // bundled: beside server.js
    path.resolve(here, '../../../assets/agents/prompt.md'), // from source
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  return found ? fs.readFileSync(found, 'utf8').trimEnd() : null;
}

/** Absolute path to the bundled MCP server, or null when there's no build to point at. */
function mcpServerPath(): string | null {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, 'mcp.js'), // bundled: beside server.js
    path.resolve(here, '../../dist/mcp.js'), // from source, if built
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * The only field that can't be static: the service's PATH has no npm bin, so `casper
 * mcp` would not spawn. null gives that short form regardless, for a hand-written file.
 */
export function agentConfig(prompt: string, mcp: string | null): KiroAgent {
  return {
    name: 'casper',
    description: 'Casper \u2014 a coding agent for developing from the chat web interface.',
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

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
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

  // lstat, not existsSync: existsSync follows a symlink left by the old installer into
  // a directory npm has replaced, reports false, then writing fails with ENOENT.
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

  // A symlink is always ours from an older install.
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
