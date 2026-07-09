import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DirListing } from '@casper/shared';
import { config } from '../config.js';

// Suggests directory paths for the New Session working-directory input. Given a
// partial path, it lists directories in the parent that match the last segment.
// Relative input is resolved against DEFAULT_CWD.
export function registerFsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>(
    '/api/fs/dirs',
    async (req): Promise<DirListing> => {
      const input = (req.query.path ?? '').trim();
      const base = config.defaultCwd;

      // Split into the directory to read and the prefix to filter on. A trailing
      // slash means "list everything inside this dir".
      const endsWithSep = input.endsWith('/');
      const resolved = input ? path.resolve(base, input) : base;
      const dir = endsWithSep || !input ? resolved : path.dirname(resolved);
      const prefix = endsWithSep || !input ? '' : path.basename(resolved);

      let entries: string[] = [];
      try {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
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
}
