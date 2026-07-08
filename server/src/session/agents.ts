import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentMode } from '@casper/shared';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/** Kiro's built-in agents, always available even without a workspace agent dir. */
const BUILTIN: AgentMode[] = [
  { id: 'kiro_default', name: 'kiro_default', description: 'General-purpose Kiro agent' },
  { id: 'kiro_planner', name: 'kiro_planner', description: 'Planning-focused agent' },
  { id: 'kiro_guide', name: 'kiro_guide', description: 'Guidance and Q&A agent' },
];

let cache: AgentMode[] | null = null;

// Strip ANSI colour codes kiro emits.
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * List available agents by parsing `kiro-cli agent list`. The output has a
 * leading "* " marker on the default and two columns (name, scope, description);
 * we only need the id/name for the picker. Cached for the process lifetime.
 */
export async function listAgents(): Promise<AgentMode[]> {
  if (cache) return cache;
  const found = new Map<string, AgentMode>();
  for (const b of BUILTIN) found.set(b.id, b);

  try {
    // `kiro-cli agent list` prints the table to STDERR, not stdout.
    const { stdout, stderr } = await execFileAsync(config.kiroBin, ['agent', 'list'], {
      cwd: config.defaultCwd,
      maxBuffer: 2 * 1024 * 1024,
    });
    const text = (stderr || '') + '\n' + (stdout || '');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(ANSI, '');
      // Rows: "* name   Global  desc..." or "  name   Global  desc..." at col 0.
      // Wrapped description lines are deeply indented and won't match.
      const m = /^\s{0,2}(\*\s)?([A-Za-z0-9_-]+)\s{2,}(Global|Workspace|Local)\b/.exec(
        line,
      );
      if (!m) continue;
      const id = m[2]!;
      if (!found.has(id)) found.set(id, { id, name: id });
    }
  } catch {
    // Fall back to builtins only.
  }

  cache = [...found.values()];
  return cache;
}
