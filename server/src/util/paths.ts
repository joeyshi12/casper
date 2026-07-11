import path from 'node:path';

/**
 * True if `target` (once resolved) is `root` itself or lives underneath it.
 * Lexical check only - resolves `..` but does not follow symlinks. The
 * `root + path.sep` suffix prevents prefix-match escapes (e.g. root
 * `/home/joey` must not match `/home/joeyx`).
 */
export function isWithinRoot(root: string, target: string): boolean {
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Resolve `input` against `root` and confine it there. Returns the absolute
 * resolved path, or null if it escapes the root (blocks `../` traversal and
 * out-of-root absolute paths).
 */
export function confineToRoot(root: string, input: string): string | null {
  const resolved = path.resolve(root, input);
  return isWithinRoot(root, resolved) ? resolved : null;
}
