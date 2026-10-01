import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentMode } from '@casper/shared';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/** Last resort, when `kiro-cli agent list` can't be read: the one agent kiro itself
 *  falls back to, so a hardcoded list can't go stale. */
const FALLBACK: AgentMode[] = [
  { id: 'kiro_default', name: 'kiro_default', description: 'General-purpose Kiro agent' },
];

// Cached briefly rather than for the process lifetime, since agents come and go
// (`/agent create`, a file dropped into ~/.kiro/agents).
const CACHE_TTL_MS = 15_000;

let cache: { at: number; agents: AgentMode[] } | null = null;

/** Forgets the cached list. Used by a session reload. */
export function invalidateAgents(): void {
  cache = null;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Lists agents by parsing `kiro-cli agent list`'s table output. */
export async function listAgents(): Promise<AgentMode[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.agents;
  const found = new Map<string, AgentMode>();

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
      const m = /^\s{0,2}(\*\s)?([A-Za-z0-9_-]+)\s{2,}(\(Built-in\)|Global|Workspace|Local)(?:\s|$)/.exec(
        line,
      );
      if (!m) continue;
      const id = m[2]!;
      if (!found.has(id)) found.set(id, { id, name: id });
    }
  } catch {
    /* fall through to the fallback below */
  }

  const agents = found.size > 0 ? [...found.values()] : FALLBACK;
  cache = { at: Date.now(), agents };
  return cache.agents;
}
