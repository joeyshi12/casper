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
import { mimeForExt } from '../util/filekind.js';
import { sendFilePreview } from './filePreview.js';

/** Maximum file size for downloads (100 MB). */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

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

      return sendFilePreview(req, reply, realTarget, stat);
    },
  );
}
