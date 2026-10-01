import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { UploadResponse, UploadedFile } from '@casper/shared';
import { config } from '../config.js';
import { classifyKind, mimeForExt } from '../util/filekind.js';
import { confineToRoot, isValidChatId } from '../util/paths.js';
import { chatUploadsDir } from '../session/chats.js';

// Uploads land in the chat's directory, not the working one, avoiding a .casper/
// folder in every project you chat about.

const STRINGS_SCAN_BYTES = 256 * 1024;

function sanitizeName(raw: string): string {
  const base = path.basename(raw).replace(/[^\w.\- ]/g, '_').trim();
  if (!base || base === '.' || base === '..') return `upload-${Date.now()}`;
  return base.replace(/^\.+/, '') || `upload-${Date.now()}`;
}

/** A non-colliding path in `dir` for `name`, adding ` (n)` before the ext. */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  let n = 1;
  while (true) {
    try {
      await fs.access(path.join(dir, candidate));
      candidate = `${stem} (${n++})${ext}`;
    } catch {
      return path.join(dir, candidate);
    }
  }
}

function sha256File(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    createReadStream(absPath)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** Best-effort `file -b <path>`; empty string if unavailable. */
function fileType(absPath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('file', ['-b', absPath], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

/** Printable ASCII strings (len >= 6) from the first chunk of a file. */
async function sampleStrings(absPath: string, limit = 40): Promise<string[]> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(absPath, 'r');
    const buf = Buffer.alloc(STRINGS_SCAN_BYTES);
    const { bytesRead } = await fh.read(buf, 0, STRINGS_SCAN_BYTES, 0);
    const out: string[] = [];
    let cur = '';
    for (let i = 0; i < bytesRead; i++) {
      const c = buf[i]!;
      if (c >= 0x20 && c <= 0x7e) {
        cur += String.fromCharCode(c);
      } else {
        if (cur.length >= 6) out.push(cur);
        cur = '';
        if (out.length >= limit) break;
      }
    }
    if (cur.length >= 6 && out.length < limit) out.push(cur);
    return out;
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

export function registerUploadRoutes(app: FastifyInstance): void {
  /** Streams each file, classifies it, and for binaries adds triage (type, sha256,
   *  sample strings). Checks nothing against the session list, since the chat may
   *  not have one yet. */
  app.post<{ Params: { chatId: string } }>(
    '/api/chats/:chatId/uploads',
    async (req, reply) => {
      if (!isValidChatId(req.params.chatId)) {
        reply.code(400);
        return { error: 'Invalid chat id' };
      }

      const uploadDir = chatUploadsDir(req.params.chatId);
      await fs.mkdir(uploadDir, { recursive: true, mode: 0o700 });

      const results: UploadedFile[] = [];
      const parts = req.files();
      for await (const part of parts) {
        const name = sanitizeName(part.filename ?? 'upload');
        if (confineToRoot(uploadDir, name) === null) continue;

        const dest = await uniquePath(uploadDir, name);
        try {
          await pipeline(part.file, createWriteStream(dest));
        } catch {
          reply.code(500);
          return { error: `Failed to store ${name}` };
        }

        if (part.file.truncated) {
          await fs.rm(dest, { force: true });
          reply.code(413);
          return {
            error: `${name} exceeds the max upload size (${Math.round(config.maxUploadBytes / 1024 / 1024)} MB)`,
          };
        }

        const stat = await fs.stat(dest);
        const ext = path.extname(dest);
        const kind = classifyKind(dest);
        const uploaded: UploadedFile = {
          name: path.basename(dest),
          path: dest,
          size: stat.size,
          mimeType: mimeForExt(ext),
          kind,
        };

        if (kind === 'binary') {
          const [type, sha256, strings] = await Promise.all([
            fileType(dest),
            sha256File(dest),
            sampleStrings(dest),
          ]);
          uploaded.triage = {
            fileType: type || undefined,
            sha256,
            strings: strings.length ? strings : undefined,
          };
        }

        results.push(uploaded);
      }

      const response: UploadResponse = { files: results };
      return response;
    },
  );
}
