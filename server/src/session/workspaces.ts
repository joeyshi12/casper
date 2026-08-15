import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Workspaces live under their own directory with their own ids: kiro only names a session
 * once it has started, and the directory has to exist before it can start in one, so
 * minting the id here means one spawn in the right place. A workspace also outlives the
 * session that created it, so a later session can be pointed at the same files.
 */
export function workspacesRoot(): string {
  return path.join(config.casperDataDir, 'workspaces');
}

export function workspaceDir(workspaceId: string): string {
  return path.join(workspacesRoot(), workspaceId);
}

/** A new, empty workspace. 0700 because it holds whatever the agent writes. */
export function createWorkspace(): { id: string; dir: string } {
  const id = crypto.randomUUID();
  const dir = workspaceDir(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { id, dir };
}
