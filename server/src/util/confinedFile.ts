import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent, Stats } from 'node:fs';
import { config } from '../config.js';
import { confineToRoot, realConfineToRoot } from './paths.js';

/**
 * The file-access sequence every file route needs, in one place: resolve the
 * path, confine it lexically, confine it again after following symlinks, stat
 * it, and check it is the kind of thing the caller asked for. A route gets back
 * either a resolved file or the status to answer with, so the ordering - and
 * the 400/403/404 policy that goes with it - is written and tested once instead
 * of once per handler.
 */

/** A path that resolved inside its roots, with the stat the route needs anyway. */
export interface ConfinedFile {
  /** Canonical, symlink-resolved absolute path. Safe to read or stream. */
  real: string;
  stat: Stats;
}

/** Why a path can't be served, and the status the route should answer with. */
export interface ConfineFailure {
  status: 400 | 403 | 404;
  error: string;
}

export type ConfineResult =
  | ({ ok: true } & ConfinedFile)
  | ({ ok: false } & ConfineFailure);

interface ConfineSpec {
  /**
   * Roots the input resolves against and must stay inside lexically. For a
   * session route this is the workspace cwd, so `../` cannot leave the project.
   */
  lexical: string[];
  /**
   * Roots the symlink-resolved path must stay inside - the security boundary.
   * Deliberately separate from `lexical`: a workspace may legitimately hold a
   * symlink pointing elsewhere under fileRoot, and that stays visible.
   */
  real: string[];
  require: 'file' | 'directory';
  /** Answered when the input escapes `lexical`. */
  escaped: ConfineFailure;
  /** Answered when the path escapes `real`, is missing, or is a directory. */
  notFound: () => ConfineFailure | Promise<ConfineFailure>;
}

async function resolveConfined(input: string, spec: ConfineSpec): Promise<ConfineResult> {
  let target: string | null = null;
  for (const root of spec.lexical) {
    target = confineToRoot(root, input);
    if (target) break;
  }
  if (!target) return { ok: false, ...spec.escaped };

  let real: string | null = null;
  for (const root of spec.real) {
    real = await realConfineToRoot(root, target);
    if (real) break;
  }
  if (!real) return { ok: false, ...(await spec.notFound()) };

  let stat: Stats;
  try {
    stat = await fs.stat(real);
  } catch {
    return { ok: false, ...(await spec.notFound()) };
  }

  // A directory asked for as a file is the caller's mistake, so it is reported.
  // A file asked for as a directory is indistinguishable from a bad path to the
  // client, and readdir would have failed the same way, so it 404s.
  if (spec.require === 'file' && !stat.isFile()) {
    return { ok: false, status: 400, error: 'Path is not a file' };
  }
  if (spec.require === 'directory' && !stat.isDirectory()) {
    return { ok: false, ...(await spec.notFound()) };
  }

  return { ok: true, real, stat };
}

/**
 * Answer a route with a failure. The translation from result to reply is the only
 * part of this the routes should own, so it is written once.
 */
export function replyWith(
  reply: { code: (status: number) => unknown },
  failure: ConfineFailure,
): { error: string } {
  reply.code(failure.status);
  return { error: failure.error };
}

/** The one method this module needs from SessionManager. */
export interface ChatCwdSource {
  getChatCwd(chatId: string): Promise<string>;
}

export type SessionPathResult =
  | ({ ok: true; cwd: string; relative: string } & ConfinedFile)
  | ({ ok: false } & ConfineFailure);

/**
 * A file or directory inside a session's workspace. `require: 'file'` also makes
 * the path mandatory, matching download and preview; the tree asks for a
 * directory and lists the cwd itself when the path is empty.
 */
export async function resolveSessionPath(
  sessions: ChatCwdSource,
  sessionId: string,
  requestedPath: string | undefined,
  require: 'file' | 'directory',
): Promise<SessionPathResult> {
  let cwd: string;
  try {
    cwd = await sessions.getChatCwd(sessionId);
  } catch {
    return { ok: false, status: 404, error: 'Session not found' };
  }

  const relative = (requestedPath ?? '').replace(/^\/+/, '');
  if (require === 'file' && !relative) {
    return { ok: false, status: 400, error: 'path parameter is required' };
  }

  const resolved = await resolveConfined(relative, {
    lexical: [cwd],
    real: [config.fileRoot],
    require,
    escaped: { status: 400, error: 'Invalid path' },
    notFound:
      require === 'file'
        ? () => ({ status: 404, error: 'File not found' })
        : () => workspaceNotFound(cwd),
  });

  return resolved.ok ? { ...resolved, cwd, relative } : resolved;
}

/**
 * A session's workspace can be moved or deleted after the session was created,
 * so a missing workspace gets its own message and the tree can explain why it
 * is empty instead of showing a bare "not found". Exported because the tree
 * needs the same answer when readdir fails after the path already resolved.
 */
export async function workspaceNotFound(cwd: string): Promise<ConfineFailure> {
  let missing: boolean;
  try {
    missing = !(await fs.stat(cwd)).isDirectory();
  } catch {
    missing = true;
  }
  return missing
    ? { status: 404, error: `Workspace folder no longer exists: ${cwd}` }
    : { status: 404, error: 'Directory not found' };
}

/**
 * Roots for paths that arrive absolute rather than relative to a session:
 * fileRoot, plus the data directory because uploads live there and a narrowed
 * CASPER_FILE_ROOT would otherwise hide the user's own attachments. Both roots
 * apply to the symlink check as well, which is what makes that promise hold.
 */
export function absoluteRoots(): string[] {
  return [config.fileRoot, config.casperDataDir];
}

export async function resolveAbsolutePath(
  input: string,
  require: 'file' | 'directory',
): Promise<ConfineResult> {
  const roots = absoluteRoots();
  return resolveConfined(input, {
    lexical: roots,
    real: roots,
    require,
    escaped: { status: 403, error: 'Path outside allowed root' },
    notFound: () => ({ status: 404, error: 'File not found' }),
  });
}

/** What a directory entry actually is, once symlinks are followed. */
export interface DirentTarget {
  kind: 'directory' | 'file';
  /** The path to stat or serve: a symlink's target rather than the link. */
  real: string;
}

/**
 * Classify one directory entry. `Dirent.isDirectory()` and `isFile()` describe
 * the entry itself, so a symlink reports false for both even when it points at
 * a real directory - resolve it to find out what it is. Returns null for
 * anything a listing should skip: a symlink escaping the roots, a broken link,
 * or a socket or device.
 */
export async function classifyDirent(
  parentReal: string,
  entry: Dirent,
  realRoots: string[],
): Promise<DirentTarget | null> {
  const absolute = path.join(parentReal, entry.name);
  if (entry.isDirectory()) return { kind: 'directory', real: absolute };
  if (entry.isFile()) return { kind: 'file', real: absolute };
  if (!entry.isSymbolicLink()) return null;

  for (const root of realRoots) {
    const real = await realConfineToRoot(root, absolute);
    if (!real) continue;
    try {
      const stat = await fs.stat(real);
      if (stat.isDirectory()) return { kind: 'directory', real };
      if (stat.isFile()) return { kind: 'file', real };
    } catch {
      /* broken link */
    }
    return null;
  }
  return null;
}
