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
  resolveChatPath,
  workspaceNotFound,
  type ChatCwdSource,
} from '../util/confinedFile.js';
import { mimeForExt } from '../util/filekind.js';
import { sendFilePreview } from './filePreview.js';

/** Maximum file size for downloads (100 MB). */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  manager: ChatCwdSource,
): void {
  /** Lists files and directories in the session's workspace, immediate children
   *  only. `path` is relative to the session's cwd. */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/chats/:id/tree',
    async (req, reply) => {
      const resolved = await resolveChatPath(
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
          // Can't stat it (e.g. broken symlink); skip.
        }
      }

      // Directories first, then alphabetical within each group.
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const response: TreeResponse = { cwd, relativeTo: relative, entries };
      return response;
    },
  );

  /** Downloads a file from the session's workspace. `path` is relative to the cwd. */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/chats/:id/download',
    async (req, reply) => {
      const resolved = await resolveChatPath(manager, req.params.id, req.query.path, 'file');
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

  /** Returns the file content for inline preview, text as UTF-8, images with their
   *  MIME type. Large files (>1 MB text, >20 MB images) are rejected. */
  app.get<{ Params: { id: string }; Querystring: { path?: string; raw?: string } }>(
    '/api/chats/:id/preview',
    async (req, reply) => {
      const resolved = await resolveChatPath(manager, req.params.id, req.query.path, 'file');
      if (!resolved.ok) return replyWith(reply, resolved);
      const { real: realTarget, stat } = resolved;

      return sendFilePreview(req, reply, realTarget, stat);
    },
  );
}
