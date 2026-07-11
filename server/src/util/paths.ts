import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * True if `target` (once resolved) is `root` itself or lives underneath it.
 * Lexical check only - resolves `..` but does not follow symlinks. The
 * `root + path.sep` suffix prevents prefix-match escapes (e.g. root
 * `/home/joey` must not match `/home/joeyx`).
 */
export function isWithinRoot(root: string, target: string): boolean {
  const resolved = path.resolve(target);
  // Filesystem root ("/" on posix) contains everything; the suffix trick below
  // would otherwise compare against "//" and reject all paths.
  if (root === path.sep) return true;
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Resolve `input` against `root` and confine it there. Returns the absolute
 * resolved path, or null if it escapes the root (blocks `../` traversal and
 * out-of-root absolute paths). Lexical only - see realConfineToRoot for a
 * symlink-safe variant.
 */
export function confineToRoot(root: string, input: string): string | null {
  const resolved = path.resolve(root, input);
  return isWithinRoot(root, resolved) ? resolved : null;
}

// Real (symlink-resolved) form of the root, cached per root value so we don't
// realpath it on every request.
let realRootCache: { root: string; real: string } | null = null;
function resolveRealRoot(root: string): string {
  if (realRootCache && realRootCache.root === root) return realRootCache.real;
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    real = root;
  }
  realRootCache = { root, real };
  return real;
}

/**
 * Symlink-safe confinement. Resolves symlinks on both the root and the target
 * with realpath, then verifies the real target is still within the real root.
 * Defeats escapes where a symlink inside the root points outside it. Returns
 * the canonical real path, or null if it escapes or the target doesn't exist.
 */
export async function realConfineToRoot(
  root: string,
  absPath: string,
): Promise<string | null> {
  let realTarget: string;
  try {
    realTarget = await fsp.realpath(absPath);
  } catch {
    return null;
  }
  return isWithinRoot(resolveRealRoot(root), realTarget) ? realTarget : null;
}

/**
 * A session id is used to build on-disk file paths. Restrict it to a safe
 * character set so it can never traverse out of the sessions directory.
 */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !id.includes('..');
}
