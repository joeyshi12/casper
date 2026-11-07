import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentMode } from '@casper/shared';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/** kiro V3's Default mode, the one it falls back to itself when an agent is missing. */
const DEFAULT_MODE: AgentMode = { id: 'vibe', name: 'Default', description: 'General coding assistance' };

// Cached briefly rather than for the process lifetime, since agents come and go
// (a file dropped into ~/.kiro/agents).
const CACHE_TTL_MS = 15_000;

let cache: { at: number; agents: AgentMode[] } | null = null;
let liveModes: AgentMode[] | null = null;

/** Forgets what was listed, so the next list reads kiro again. Used by a session reload,
 *  which is how a user has kiro re-read its agent files. */
export function invalidateAgents(): void {
  cache = null;
  liveModes = null;
}

/** The modes a kiro session just reported. They are exactly what a new session accepts,
 *  so they are listed in preference to `kiro-cli agent list`. */
export function rememberModes(modes: AgentMode[]): void {
  if (modes.length > 0) liveModes = modes;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * The agents a new chat can start with. Until a kiro session has reported its modes,
 * this is the Default mode plus the user's own agents from `kiro-cli agent list`. That
 * command still prints kiro 2.x's built-in agents, which V3 has no mode for, so those
 * rows are skipped.
 */
export async function listAgents(): Promise<AgentMode[]> {
  if (liveModes) return liveModes;
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.agents;
  const found = new Map<string, AgentMode>([[DEFAULT_MODE.id, DEFAULT_MODE]]);

  try {
    // Prints the table to stderr, not stdout.
    const { stdout, stderr } = await execFileAsync(config.kiroBin, ['agent', 'list'], {
      cwd: config.defaultCwd,
      maxBuffer: 2 * 1024 * 1024,
    });
    const text = (stderr || '') + '\n' + (stdout || '');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(ANSI, '');
      // Rows: "* name  <scope>  description". A "Global: <path>" header line
      // doesn't match, since a colon follows the word rather than spaces.
      const m = /^\s{0,2}(\*\s)?([A-Za-z0-9_-]+)\s{2,}(Global|Workspace|Local)(?:\s|$)/.exec(line);
      if (!m) continue;
      const id = m[2]!;
      if (!found.has(id)) found.set(id, { id, name: id });
    }
  } catch {
    /* the Default mode alone */
  }

  cache = { at: Date.now(), agents: [...found.values()] };
  return cache.agents;
}
