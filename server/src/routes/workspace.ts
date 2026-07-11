import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FileEntry, TreeResponse } from '@casper/shared';
import type { SessionManager } from '../session/SessionManager.js';
import { config } from '../config.js';
import { confineToRoot, realConfineToRoot } from '../util/paths.js';
import { classifyKind } from '../util/filekind.js';

/** Directories to exclude from tree listings. */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.cache',
  'target',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
]);

/** Maximum file size for downloads (100 MB). */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Resolves a relative path within the session cwd and validates it doesn't
 * escape. Returns the absolute resolved path or null if traversal detected.
 */
function safePath(root: string, relative: string): string | null {
  return confineToRoot(root, relative);
}

/** Max bytes to hexdump for a binary preview. */
const HEXDUMP_BYTES = 4096;

/** Render a canonical `hexdump -C` style view of a buffer. */
function hexdump(buf: Buffer): string {
  const lines: string[] = [];
  for (let off = 0; off < buf.length; off += 16) {
    const slice = buf.subarray(off, off + 16);
    const hex: string[] = [];
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (i < slice.length) {
        const b = slice[i]!;
        hex.push(b.toString(16).padStart(2, '0'));
        ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
      } else {
        hex.push('  ');
      }
      if (i === 7) hex.push('');
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.join(' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}

/** Infer a MIME type from a file extension. */
function mimeType(ext: string): string {
  const map: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.toml': 'text/plain',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.wasm': 'application/wasm',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  manager: SessionManager,
): void {
  /**
   * GET /api/sessions/:id/tree?path=<relative>&depth=1
   *
   * Lists files and directories in the session's workspace.
   * The `path` parameter is relative to the session's cwd.
   * Returns immediate children only (lazy loading; expand on demand).
   */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/sessions/:id/tree',
    async (req, reply) => {
      let cwd: string;
      try {
        cwd = await manager.getSessionCwd(req.params.id);
      } catch {
        reply.code(404);
        return { error: 'Session not found' };
      }

      const relative = (req.query.path ?? '').replace(/^\/+/, '');
      const target = safePath(cwd, relative);
      if (!target) {
        reply.code(400);
        return { error: 'Invalid path' };
      }

      // Symlink-safe: reject if the real target escapes fileRoot.
      const realTarget = await realConfineToRoot(config.fileRoot, target);
      if (!realTarget) {
        reply.code(404);
        return { error: 'Directory not found' };
      }

      let dirents: import('node:fs').Dirent<string>[];
      try {
        dirents = await fs.readdir(realTarget, { withFileTypes: true, encoding: 'utf8' });
      } catch {
        reply.code(404);
        return { error: 'Directory not found' };
      }

      const entries: FileEntry[] = [];
      for (const d of dirents) {
        const name = d.name as string;
        // Skip hidden directories, except .casper so users can see and download
        // their uploaded files (stored under .casper/uploads/).
        if (name.startsWith('.') && name !== '.casper' && d.isDirectory()) continue;
        if (d.isDirectory() && EXCLUDED_DIRS.has(name)) continue;

        const entryRelative = relative ? `${relative}/${name}` : name;
        const entryAbsolute = path.join(realTarget, name);

        if (d.isDirectory()) {
          entries.push({ name, path: entryRelative, type: 'directory' });
        } else if (d.isFile()) {
          try {
            const stat = await fs.stat(entryAbsolute);
            entries.push({
              name,
              path: entryRelative,
              type: 'file',
              size: stat.size,
              modifiedAt: stat.mtime.toISOString(),
            });
          } catch {
            // Skip files we can't stat (e.g. broken symlinks).
          }
        }
      }

      // Sort: directories first, then alphabetical within each group.
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const response: TreeResponse = { cwd, relativeTo: relative, entries };
      return response;
    },
  );

  /**
   * GET /api/sessions/:id/download?path=<relative>
   *
   * Downloads a file from the session's workspace.
   * The `path` parameter is relative to the session's cwd.
   */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/sessions/:id/download',
    async (req, reply) => {
      let cwd: string;
      try {
        cwd = await manager.getSessionCwd(req.params.id);
      } catch {
        reply.code(404);
        return { error: 'Session not found' };
      }

      const relative = (req.query.path ?? '').replace(/^\/+/, '');
      if (!relative) {
        reply.code(400);
        return { error: 'path parameter is required' };
      }

      const target = safePath(cwd, relative);
      if (!target) {
        reply.code(400);
        return { error: 'Invalid path' };
      }

      // Symlink-safe: reject if the real target escapes fileRoot.
      const realTarget = await realConfineToRoot(config.fileRoot, target);
      if (!realTarget) {
        reply.code(404);
        return { error: 'File not found' };
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(realTarget);
      } catch {
        reply.code(404);
        return { error: 'File not found' };
      }

      if (!stat.isFile()) {
        reply.code(400);
        return { error: 'Path is not a file' };
      }

      if (stat.size > MAX_DOWNLOAD_BYTES) {
        reply.code(413);
        return { error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max 100 MB)` };
      }

      const ext = path.extname(realTarget);
      const filename = path.basename(realTarget);
      // RFC 5987 encoding avoids header injection from quotes/specials in the
      // filename; the ASCII fallback strips anything outside a safe set.
      const asciiName = filename.replace(/[^\w.\-]/g, '_');

      reply.header('Content-Type', mimeType(ext));
      reply.header(
        'Content-Disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      reply.header('Content-Length', stat.size);

      return reply.send(createReadStream(realTarget));
    },
  );

  /**
   * GET /api/sessions/:id/preview?path=<relative>
   *
   * Returns the file content for inline preview. Text files are returned as
   * UTF-8 text; images are returned with their MIME type for inline display.
   * Large files (>1 MB for text, >20 MB for images) are rejected.
   */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/sessions/:id/preview',
    async (req, reply) => {
      let cwd: string;
      try {
        cwd = await manager.getSessionCwd(req.params.id);
      } catch {
        reply.code(404);
        return { error: 'Session not found' };
      }

      const relative = (req.query.path ?? '').replace(/^\/+/, '');
      if (!relative) {
        reply.code(400);
        return { error: 'path parameter is required' };
      }

      const target = safePath(cwd, relative);
      if (!target) {
        reply.code(400);
        return { error: 'Invalid path' };
      }

      // Symlink-safe: reject if the real target escapes fileRoot.
      const realTarget = await realConfineToRoot(config.fileRoot, target);
      if (!realTarget) {
        reply.code(404);
        return { error: 'File not found' };
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(realTarget);
      } catch {
        reply.code(404);
        return { error: 'File not found' };
      }

      if (!stat.isFile()) {
        reply.code(400);
        return { error: 'Path is not a file' };
      }

      const ext = path.extname(realTarget).toLowerCase();
      const mime = mimeType(ext);
      const isImage = mime.startsWith('image/');
      const kind = classifyKind(realTarget);

      // Binaries are only hexdumped (fixed head), so no size gate for them.
      // Images cap at 20 MB, text at 1 MB.
      if (kind !== 'binary') {
        const maxSize = isImage ? 20 * 1024 * 1024 : 1024 * 1024;
        if (stat.size > maxSize) {
          reply.code(413);
          return {
            error: `File too large for preview (${(stat.size / 1024 / 1024).toFixed(1)} MB, max ${isImage ? '20' : '1'} MB)`,
          };
        }
      }

      // For images, stream the binary with Content-Disposition: inline.
      if (isImage) {
        reply.header('Content-Type', mime);
        reply.header('Content-Disposition', 'inline');
        reply.header('Content-Length', stat.size);
        return reply.send(createReadStream(realTarget));
      }

      // For binary files, previewing raw bytes as text is useless - return a
      // hexdump of the first chunk instead so the panel shows something sane.
      if (kind === 'binary') {
        let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
          fh = await fs.open(realTarget, 'r');
          const buf = Buffer.alloc(Math.min(HEXDUMP_BYTES, stat.size));
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          const dump = hexdump(buf.subarray(0, bytesRead));
          const header =
            `Binary file - ${stat.size} bytes\n` +
            `Showing first ${bytesRead} bytes as hexdump:\n\n`;
          const body = header + dump + (stat.size > bytesRead ? '\n\n… (truncated)' : '');
          reply.header('Content-Type', 'text/plain; charset=utf-8');
          reply.header('Content-Disposition', 'inline');
          return reply.send(body);
        } finally {
          await fh?.close();
        }
      }

      // For text/code files, return as UTF-8 text.
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', 'inline');
      reply.header('Content-Length', stat.size);
      return reply.send(createReadStream(realTarget));
    },
  );
}
