/**
 * Tool calls record the path the agent was given, which is normally absolute. The
 * session preview endpoint takes a path relative to the workspace and confines it
 * there, so a file outside the workspace cannot be previewed at all - null says so,
 * and the caller shows the name as plain text instead of a link.
 */
export function workspaceRelative(cwd: string, filePath: string): string | null {
  if (!cwd || !filePath) return null;

  // The file tree already deals in relative paths; take those as they are.
  if (!filePath.startsWith('/')) return collapse(filePath.replace(/^\.\//, ''));

  const root = trimSlashes(cwd);
  const target = collapse(trimSlashes(filePath));
  if (target === null) return null;
  if (target === root) return null; // the workspace itself is a directory, not a file
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : null;
}

const trimSlashes = (p: string) => p.replace(/\/+$/, '');

/** Resolve `.` and `..` segments. Null when they climb past the start. */
function collapse(p: string): string | null {
  const absolute = p.startsWith('/');
  const out: string[] = [];
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') {
      out.push(segment);
      continue;
    }
    if (out.length === 0) return null;
    out.pop();
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined;
}
