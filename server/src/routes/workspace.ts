import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FileEntry, TreeResponse } from '@casper/shared';
import { config } from '../config.js';
import {
  classifyDirent,
  replyWith,
  resolveSessionPath,
  workspaceNotFound,
  type SessionCwdSource,
} from '../util/confinedFile.js';
import { classifyKind, mimeForExt, looksBinary } from '../util/filekind.js';

/** Maximum file size for downloads (100 MB). */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** Max bytes to hexdump for a binary preview. */
const HEXDUMP_BYTES = 4096;

/** Preview size caps: text/code at 1 MB, images at 20 MB. */
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;

function tooLargeForPreview(size: number, maxBytes: number): { error: string } {
  return {
    error: `File too large for preview (${(size / 1024 / 1024).toFixed(1)} MB, max ${maxBytes / 1024 / 1024} MB)`,
  };
}

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

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  manager: SessionCwdSource,
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
      const resolved = await resolveSessionPath(
        manager,
        req.params.id,
        req.query.path,
        'directory',
      );
      if (!resolved.ok) return replyWith(reply, resolved);
      const { cwd, relative, real: realTarget } = resolved;

      let dirents: Dirent[];
      try {
        dirents = await fs.readdir(realTarget, { withFileTypes: true, encoding: 'utf8' });
      } catch {
        return replyWith(reply, await workspaceNotFound(cwd));
      }

      const entries: FileEntry[] = [];
      for (const d of dirents) {
        const target = await classifyDirent(realTarget, d, [config.fileRoot]);
        if (!target) continue;

        const entryRelative = relative ? `${relative}/${d.name}` : d.name;
        if (target.kind === 'directory') {
          entries.push({ name: d.name, path: entryRelative, type: 'directory' });
          continue;
        }

        try {
          const stat = await fs.stat(target.real);
          entries.push({
            name: d.name,
            path: entryRelative,
            type: 'file',
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        } catch {
          // Skip files we can't stat (e.g. broken symlinks).
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
      const resolved = await resolveSessionPath(manager, req.params.id, req.query.path, 'file');
      if (!resolved.ok) return replyWith(reply, resolved);
      const { real: realTarget, stat } = resolved;

      if (stat.size > MAX_DOWNLOAD_BYTES) {
        reply.code(413);
        return { error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max 100 MB)` };
      }

      const ext = path.extname(realTarget);
      const filename = path.basename(realTarget);
      // RFC 5987 encoding avoids header injection from quotes/specials in the
      // filename; the ASCII fallback strips anything outside a safe set.
      const asciiName = filename.replace(/[^\w.\-]/g, '_');

      reply.header('Content-Type', mimeForExt(ext));
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
  app.get<{ Params: { id: string }; Querystring: { path?: string; raw?: string } }>(
    '/api/sessions/:id/preview',
    async (req, reply) => {
      const resolved = await resolveSessionPath(manager, req.params.id, req.query.path, 'file');
      if (!resolved.ok) return replyWith(reply, resolved);
      const { real: realTarget, stat } = resolved;

      const ext = path.extname(realTarget).toLowerCase();
      const mime = mimeForExt(ext);
      const isImage = mime.startsWith('image/');
      const isPdf = mime === 'application/pdf';
      // Served raw so the panel can render it in an iframe rather than showing
      // source. `raw=1` is required: without it a bare link to this endpoint
      // would hand an agent-authored page the same origin as the API.
      const isHtml = mime === 'text/html' && req.query.raw === '1';
      const kind = classifyKind(realTarget);

      // Binaries are only hexdumped (fixed head), so no size gate for them.
      // Images and PDFs cap at 20 MB, text at 1 MB.
      if (isImage || isPdf) {
        if (stat.size > MAX_IMAGE_PREVIEW_BYTES) {
          reply.code(413);
          return tooLargeForPreview(stat.size, MAX_IMAGE_PREVIEW_BYTES);
        }
      } else if (kind !== 'binary') {
        if (stat.size > MAX_TEXT_PREVIEW_BYTES) {
          reply.code(413);
          return tooLargeForPreview(stat.size, MAX_TEXT_PREVIEW_BYTES);
        }
      }

      // Raw HTML for the rendered preview. The CSP sandbox applies however the
      // response is loaded - including direct navigation, where the iframe's own
      // sandbox attribute wouldn't - so the page can never act as the user.
      if (isHtml) {
        if (stat.size > MAX_TEXT_PREVIEW_BYTES) {
          reply.code(413);
          return tooLargeForPreview(stat.size, MAX_TEXT_PREVIEW_BYTES);
        }
        reply.header('Content-Security-Policy', 'sandbox allow-scripts allow-forms');
        reply.header('Content-Type', 'text/html; charset=utf-8');
        reply.header('Cache-Control', 'no-store');
        return reply.send(createReadStream(realTarget));
      }

      // Stream images and PDFs with Content-Disposition: inline so the browser
      // renders them directly (in an <img> or the built-in PDF viewer).
      if (isImage || isPdf) {
        // Transcript images re-render on every reload and every reconnect
        // replay, so without a validator the browser refetches each one in full
        // every time. Matches the /api/fs/image cache policy. The validator is
        // size+mtime rather than a content hash to avoid reading the file.
        //
        // no-cache, not max-age: workspace files are mutable, and a freshness
        // window serves a stale body without ever asking. Revalidating every
        // time still costs only an empty 304 when nothing changed.
        const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
        reply.header('Cache-Control', 'private, no-cache');
        reply.header('ETag', etag);
        reply.header('Last-Modified', stat.mtime.toUTCString());

        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch === etag) {
          reply.code(304);
          return reply.send();
        }

        reply.header('Content-Type', mime);
        reply.header('Content-Disposition', 'inline');
        reply.header('Content-Length', stat.size);
        return reply.send(createReadStream(realTarget));
      }

      // For binary files, previewing raw bytes as text is useless - return a
      // hexdump of the first chunk instead so the panel shows something sane.
      // But the extension allowlist can't recognise dotfiles or extensionless
      // files, so sniff the sampled bytes first: text is served as text.
      if (kind === 'binary') {
        let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
          fh = await fs.open(realTarget, 'r');
          const buf = Buffer.alloc(Math.min(HEXDUMP_BYTES, stat.size));
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          const head = buf.subarray(0, bytesRead);

          if (!looksBinary(head)) {
            if (stat.size > MAX_TEXT_PREVIEW_BYTES) {
              reply.code(413);
              return tooLargeForPreview(stat.size, MAX_TEXT_PREVIEW_BYTES);
            }
            reply.header('Content-Type', 'text/plain; charset=utf-8');
            reply.header('Content-Disposition', 'inline');
            reply.header('Content-Length', stat.size);
            return reply.send(createReadStream(realTarget));
          }

          const dump = hexdump(head);
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

      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', 'inline');
      reply.header('Content-Length', stat.size);
      return reply.send(createReadStream(realTarget));
    },
  );
}
