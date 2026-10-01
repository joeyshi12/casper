import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent, Stats } from 'node:fs';
import { config } from '../config.js';
import { confineToRoot, realConfineToRoot } from './paths.js';

// The file-access sequence every route needs: confine lexically, confine again past
// symlinks, stat, then check the kind. Written once for a consistent 400/403/404 policy.

/** A path resolved inside its roots, with the stat the route needs anyway. */
export interface ConfinedFile {
  real: string;
  stat: Stats;
}

export interface ConfineFailure {
  status: 400 | 403 | 404;
  error: string;
}

export type ConfineResult =
  | ({ ok: true } & ConfinedFile)
  | ({ ok: false } & ConfineFailure);

interface ConfineSpec {
  /** Roots the input must stay inside lexically (blocks `../`). */
  lexical: string[];
  /** Roots the symlink-resolved path must stay inside: the real security boundary,
   *  kept separate since a workspace may hold a symlink elsewhere under fileRoot. */
  real: string[];
  require: 'file' | 'directory';
  escaped: ConfineFailure;
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

  // A directory asked for as a file is a 400; the reverse 404s, matching readdir.
  if (spec.require === 'file' && !stat.isFile()) {
    return { ok: false, status: 400, error: 'Path is not a file' };
  }
  if (spec.require === 'directory' && !stat.isDirectory()) {
    return { ok: false, ...(await spec.notFound()) };
  }

  return { ok: true, real, stat };
}

export function replyWith(
  reply: { code: (status: number) => unknown },
  failure: ConfineFailure,
): { error: string } {
  reply.code(failure.status);
  return { error: failure.error };
}

export interface ChatCwdSource {
  getChatCwd(chatId: string): Promise<string>;
}

export type ChatPathResult =
  | ({ ok: true; cwd: string; relative: string } & ConfinedFile)
  | ({ ok: false } & ConfineFailure);

/** A file or directory inside a session's workspace. `require: 'file'` makes the
 *  path mandatory; the tree lists the cwd itself when the path is empty. */
export async function resolveChatPath(
  sessions: ChatCwdSource,
  sessionId: string,
  requestedPath: string | undefined,
  require: 'file' | 'directory',
): Promise<ChatPathResult> {
  let cwd: string;
  try {
    cwd = await sessions.getChatCwd(sessionId);
  } catch {
    return { ok: false, status: 404, error: 'Chat not found' };
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

/** A workspace can be moved or deleted after creation; exported so the tree can
 *  give the same answer when readdir fails after the path already resolved. */
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

/** Roots for paths that arrive absolute: fileRoot, plus the data directory so a
 *  narrowed CASPER_FILE_ROOT doesn't hide the user's own uploads. */
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
  real: string;
}

/** Dirent.isDirectory()/isFile() report false for a symlink even when it points at
 *  a real directory, so resolve it. Null for a symlink escaping the roots, a broken
 *  link, or a socket/device. */
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
