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
import { sendFilePreview } from './filePreview.js';

// Suggests directory paths for the New Session working-directory input, matching
// the last segment of a partial path. Relative input resolves against DEFAULT_CWD,
// confined to fileRoot.
export function registerFsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>(
    '/api/fs/dirs',
    async (req, reply): Promise<DirListing | { error: string }> => {
      const input = (req.query.path ?? '').trim();
      const base = config.defaultCwd;

      // A trailing slash means "list everything inside this dir".
      const endsWithSep = input.endsWith('/');
      const resolved = input ? path.resolve(base, input) : base;
      const dir = endsWithSep || !input ? resolved : path.dirname(resolved);
      const prefix = endsWithSep || !input ? '' : path.basename(resolved);

      const targetKind: DirListing['targetKind'] = await fs
        .stat(resolved)
        .then((s) => (s.isDirectory() ? ('directory' as const) : ('file' as const)))
        .catch(() => 'missing' as const);

      const listing = await resolveAbsolutePath(dir, 'directory');
      if (!listing.ok) {
        if (listing.status === 403) return replyWith(reply, listing);
        return { dir, entries: [], target: resolved, targetKind };
      }
      const realDir = listing.real;

      let entries: string[] = [];
      try {
        const dirents = await fs.readdir(realDir, { withFileTypes: true });
        const checks = await Promise.all(
          dirents.map(async (d) => {
            const target = await classifyDirent(realDir, d, absoluteRoots());
            return target?.kind === 'directory' ? d.name : null;
          }),
        );
        // Dot-directories sort after the rest rather than being filtered out.
        const isDot = (name: string) => name.startsWith('.');
        entries = checks
          .filter((name): name is string => name !== null)
          .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
          .sort((a, b) => {
            if (isDot(a) !== isDot(b)) return isDot(a) ? 1 : -1;
            return a.localeCompare(b);
          })
          .slice(0, 500)
          .map((name) => path.join(dir, name));
      } catch {
        entries = [];
      }

      return { dir, entries, target: resolved, targetKind };
    },
  );

  /** Previews any file by absolute path, confined to fileRoot and the data
   *  directory, so it can reach uploads outside every workspace. */
  app.get<{ Querystring: { path?: string; raw?: string; download?: string } }>(
    '/api/fs/file',
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
      const resolved = await resolveAbsolutePath(filePath, 'file');
      if (!resolved.ok) return replyWith(reply, resolved);
      if (req.query.download === '1') {
        reply.header('Content-Type', 'application/octet-stream');
        reply.header(
          'Content-Disposition',
          `attachment; filename="${path.basename(resolved.real).replace(/"/g, '')}"`,
        );
        reply.header('Content-Length', resolved.stat.size);
        return reply.send(createReadStream(resolved.real));
      }
      return sendFilePreview(req, reply, resolved.real, resolved.stat);
    },
  );
}
