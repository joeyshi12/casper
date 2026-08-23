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

/** Max image file size (20 MB). */

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
        const checks = await Promise.all(
          dirents.map(async (d) => {
            const target = await classifyDirent(realDir, d, absoluteRoots());
            return target?.kind === 'directory' ? d.name : null;
          }),
        );
        // Dot-directories are listed, ordered after the rest. The cap is generous because
        // ordering them last would otherwise starve them: 20 entries meant .kiro never
        // appeared in a folder with 20 ordinary siblings. The client filters and scrolls.
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

  /**
   * GET /api/fs/file?path=<absolute-path>
   *
   * Preview any file by absolute path, confined to the same roots as the rest of this
   * module: config.fileRoot and the data directory. Uploads live under the data directory,
   * outside every session's working directory, so the workspace preview route - which
   * confines lexically to the cwd - cannot reach them. Serves whatever the file is: text as
   * text, images and PDFs inline, binaries as a hexdump.
   */
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
      // download=1 sends the bytes as a file rather than previewing them: the preview path
      // is inline-only and caps text at 1 MB, so routing Download at it opened an upload in
      // a tab instead of saving it.
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
