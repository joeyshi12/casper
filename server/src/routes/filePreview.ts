import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { classifyKind, mimeForExt, looksBinary } from '../util/filekind.js';

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

/**
 * Serve one already-resolved file for inline preview.
 *
 * Shared by the workspace route, which resolves a path relative to a session's cwd, and the
 * filesystem route, which takes an absolute one - uploads live under the data directory,
 * outside any session's working directory, so a cwd-relative route cannot reach them.
 * Confinement is the caller's job and has happened before this is called.
 */
export async function sendFilePreview(
  req: FastifyRequest<{ Querystring: { raw?: string } }>,
  reply: FastifyReply,
  realTarget: string,
  stat: Stats,
): Promise<unknown> {
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
    // every time. The validator is
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
}
