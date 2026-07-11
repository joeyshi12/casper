import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DirListing } from '@casper/shared';
import { config } from '../config.js';
import { confineToRoot, realConfineToRoot } from '../util/paths.js';

/** Allowed image MIME types for the file serving endpoint. */
const IMAGE_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/** Max image file size (20 MB). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Confine a path to the configured file root. */
function confinedPath(input: string): string | null {
  return confineToRoot(config.fileRoot, input);
}

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

      // Confine the directory being listed to fileRoot so this can't be used to
      // enumerate arbitrary filesystem locations.
      if (confinedPath(dir) === null) {
        reply.code(403);
        return { error: 'Path outside allowed root' };
      }

      // Symlink-safe: if the dir resolves (through symlinks) outside fileRoot,
      // or doesn't exist, return no suggestions rather than leaking anything.
      const realDir = await realConfineToRoot(config.fileRoot, dir);
      if (!realDir) {
        return { dir, entries: [] };
      }

      let entries: string[] = [];
      try {
        const dirents = await fs.readdir(realDir, { withFileTypes: true });
        entries = dirents
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => d.name)
          .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 20)
          .map((name) => path.join(dir, name));
      } catch {
        entries = [];
      }

      return { dir, entries };
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

      // Must be an absolute path.
      if (!path.isAbsolute(filePath)) {
        reply.code(400);
        return { error: 'path must be absolute' };
      }

      // Resolve and confine to fileRoot so this can't read arbitrary files
      // (e.g. system files or SSH keys) outside the allowed boundary.
      const resolved = confinedPath(filePath);
      if (resolved === null) {
        reply.code(403);
        return { error: 'Path outside allowed root' };
      }

      // Validate extension is an image type.
      const ext = path.extname(resolved).toLowerCase();
      const mime = IMAGE_MIMES[ext];
      if (!mime) {
        reply.code(400);
        return { error: `Not a supported image type: ${ext}` };
      }

      // Symlink-safe: reject if the real path escapes fileRoot.
      const real = await realConfineToRoot(config.fileRoot, resolved);
      if (!real) {
        reply.code(404);
        return { error: 'File not found' };
      }

      // Stat the file.
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(real);
      } catch {
        reply.code(404);
        return { error: 'File not found' };
      }

      if (!stat.isFile()) {
        reply.code(400);
        return { error: 'Path is not a file' };
      }

      if (stat.size > MAX_IMAGE_BYTES) {
        reply.code(413);
        return { error: 'Image too large' };
      }

      reply.header('Content-Type', mime);
      reply.header('Content-Length', stat.size);
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(createReadStream(real));
    },
  );
}
