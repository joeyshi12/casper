import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/**
 * Put the bundled casper agent where kiro looks for it, so `--agent casper`
 * resolves from any working directory.
 *
 * The shell installer symlinked into the install directory. That can't work from a
 * package: npm replaces the install directory on upgrade and deletes it on removal,
 * either of which leaves kiro following a dangling link. So this copies, and
 * records the hash of what it wrote. On a later run an unchanged copy is refreshed
 * and an edited one is left alone - without the stamp there's no way to tell your
 * edits from last version's file.
 */
export type AgentResult =
  | { action: 'installed' | 'updated' | 'unchanged'; target: string }
  | { action: 'kept-yours' | 'no-source'; target: string };

function sourceFile(): string {
  // dist/server.js -> dist/../assets, and src/cli/ -> ../../../assets in a workspace.
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const packaged = path.resolve(here, '../assets/agents/casper.json');
  const workspace = path.resolve(here, '../../../assets/agents/casper.json');
  return fs.existsSync(packaged) ? packaged : workspace;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function installAgentFile(home: string, dataDir: string): AgentResult {
  const src = sourceFile();
  const target = path.join(home, '.kiro', 'agents', 'casper.json');
  if (!fs.existsSync(src)) return { action: 'no-source', target };

  const desired = fs.readFileSync(src, 'utf8');
  const stampFile = path.join(dataDir, 'agent-stamp');
  const stamp = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';

  const write = () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, desired);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stampFile, `${sha256(desired)}\n`);
  };

  // lstat, not existsSync: a symlink left behind by the shell installer points into
  // a directory npm has since replaced, and existsSync follows it and reports false.
  // Writing then goes through the broken link and fails with ENOENT.
  let current: fs.Stats | undefined;
  try {
    current = fs.lstatSync(target);
  } catch {
    current = undefined;
  }

  if (!current) {
    write();
    return { action: 'installed', target };
  }

  // A symlink is always ours from an older install, never the user's own edits.
  if (current.isSymbolicLink()) {
    fs.rmSync(target);
    write();
    return { action: 'updated', target };
  }

  const onDisk = fs.readFileSync(target, 'utf8');
  if (sha256(onDisk) === sha256(desired)) return { action: 'unchanged', target };
  if (stamp !== '' && sha256(onDisk) === stamp) {
    write();
    return { action: 'updated', target };
  }
  return { action: 'kept-yours', target };
}
