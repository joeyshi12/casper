import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether `target` resolves to `root` or below it. Lexical only: resolves `..`, ignores
 * symlinks. The `path.sep` suffix stops `/home/joey` matching `/home/joeyx`.
 */
export function isWithinRoot(root: string, target: string): boolean {
  const resolved = path.resolve(target);
  // "/" contains everything, and the suffix below would compare against "//".
  if (root === path.sep) return true;
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** Resolve `input` under `root`, or null if it escapes. Lexical; see realConfineToRoot. */
export function confineToRoot(root: string, input: string): string | null {
  const resolved = path.resolve(root, input);
  return isWithinRoot(root, resolved) ? resolved : null;
}

// Cached so the root isn't realpath'd on every request.
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
 * Confinement that survives symlinks: realpaths both sides before comparing, which defeats a
 * symlink inside the root pointing out of it. Null if it escapes or does not exist.
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

/** A session id names files, so restrict it to what cannot traverse. */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && !id.includes('..');
}

/** A chat id comes from the client and names a directory, so restrict it the same way. */
export function isValidChatId(id: string | undefined): id is string {
  return !!id && isValidSessionId(id);
}
