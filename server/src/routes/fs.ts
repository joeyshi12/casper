import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DirListing } from '@casper/shared';
import { config } from '../config.js';
import {
  absoluteRoots,
  classifyDirent,
  replyWith,
  resolveAbsolutePath,
} from '../util/confinedFile.js';
import { classifyKind, mimeForExt } from '../util/filekind.js';

/** Max image file size (20 MB). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Suggests directory paths for the New Session working-directory input. Given a
// partial path, it lists directories in the parent that match the last segment.
// Relative input is resolved against DEFAULT_CWD, and confined to fileRoot.
export function registerFsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>(
    '/api/fs/dirs',
    async (req, reply): Promise<DirListing | { error: string }> => {
      const input = (req.query.path ?? '').trim();
      const base = config.defaultCwd;

      // Split into the directory to read and the prefix to filter on. A trailing
      // slash means "list everything inside this dir".
      const endsWithSep = input.endsWith('/');
      const resolved = input ? path.resolve(base, input) : base;
      const dir = endsWithSep || !input ? resolved : path.dirname(resolved);
      const prefix = endsWithSep || !input ? '' : path.basename(resolved);

      // What the path being typed currently is. Reported so the sheet can say
      // the folder will be created - or that the path is a file, which
      // resolveCwd() in SessionManager rejects. Same DEFAULT_CWD base as create.
      const targetKind: DirListing['targetKind'] = await fs
        .stat(resolved)
        .then((s) => (s.isDirectory() ? ('directory' as const) : ('file' as const)))
        .catch(() => 'missing' as const);

      // Confine the directory being listed so this can't be used to enumerate
      // arbitrary filesystem locations. A path that resolves (through symlinks)
      // outside the roots, or doesn't exist, yields no suggestions rather than
      // leaking anything.
      const listing = await resolveAbsolutePath(dir, 'directory');
      if (!listing.ok) {
        if (listing.status === 403) return replyWith(reply, listing);
        return { dir, entries: [], target: resolved, targetKind };
      }
      const realDir = listing.real;

      let entries: string[] = [];
      try {
        const dirents = await fs.readdir(realDir, { withFileTypes: true });
        const candidates = dirents.filter((d) => !d.name.startsWith('.'));
        const checks = await Promise.all(
          candidates.map(async (d) => {
            const target = await classifyDirent(realDir, d, absoluteRoots());
            return target?.kind === 'directory' ? d.name : null;
          }),
        );
        entries = checks
          .filter((name): name is string => name !== null)
          .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 20)
          .map((name) => path.join(dir, name));
      } catch {
        entries = [];
      }

      return { dir, entries, target: resolved, targetKind };
    },
  );

  /**
   * GET /api/fs/image?path=<absolute-path>
   *
   * Serves an image file from the server filesystem. Used to render images
   * produced by tool calls (e.g. charts, screenshots) inline in the chat.
   * Only serves files with recognized image extensions; rejects anything else.
   */
  app.get<{ Querystring: { path?: string } }>(
    '/api/fs/image',
    async (req, reply) => {
      const filePath = (req.query.path ?? '').trim();
      if (!filePath) {
        reply.code(400);
        return { error: 'path parameter is required' };
      }

      if (!path.isAbsolute(filePath)) {
        reply.code(400);
        return { error: 'path must be absolute' };
      }

      // Extension allowlist first: pure input validation, no filesystem access.
      // classifyKind reads the same table the ACP image blocks use.
      const ext = path.extname(filePath).toLowerCase();
      if (classifyKind(filePath) !== 'image') {
        reply.code(400);
        return { error: `Not a supported image type: ${ext}` };
      }

      const resolvedImage = await resolveAbsolutePath(filePath, 'file');
      if (!resolvedImage.ok) return replyWith(reply, resolvedImage);
      const { real, stat } = resolvedImage;

      if (stat.size > MAX_IMAGE_BYTES) {
        reply.code(413);
        return { error: 'Image too large' };
      }

      // no-cache, not max-age: the file can be rewritten at any time, so the
      // browser must revalidate rather than trust a freshness window. Matches
      // the workspace preview policy; unchanged files still cost only a 304.
      const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
      reply.header('Cache-Control', 'private, no-cache');
      reply.header('ETag', etag);
      reply.header('Last-Modified', stat.mtime.toUTCString());

      if (req.headers['if-none-match'] === etag) {
        reply.code(304);
        return reply.send();
      }

      reply.header('Content-Type', mimeForExt(ext));
      reply.header('Content-Length', stat.size);
      return reply.send(createReadStream(real));
    },
  );
}
