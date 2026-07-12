import path from 'node:path';
import type { UploadKind } from '@casper/shared';

/** Image extensions that can be inlined as ACP image content blocks. */
const IMAGE_EXTS: Record<string, string> = {
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

/** Text/code extensions safe to read as UTF-8 and inline. */
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.env', '.cfg', '.conf',
  '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp',
  '.cc', '.cs', '.php', '.swift', '.scala', '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.proto', '.dockerfile', '.makefile', '.gradle',
  '.diff', '.patch', '.tex',
]);

/** Broader MIME map for serving files (superset used by download). */
const MIME_MAP: Record<string, string> = {
  ...IMAGE_EXTS,
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.toml': 'text/plain',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dll': 'application/vnd.microsoft.portable-executable',
  '.so': 'application/x-sharedlib',
  '.bin': 'application/octet-stream',
};

export function mimeForExt(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Content-based binary sniff over a sampled head of a file. A NUL byte is a
 * strong binary signal (matches git's heuristic); otherwise a high ratio of
 * C0 control characters indicates binary. Empty input is treated as text.
 * Used to rescue extensionless/dotfile text (.gitignore, .nvmrc, Makefile)
 * that the extension allowlist cannot classify.
 */
export function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  // UTF-16 BOM: valid text, but not UTF-8, so it renders as garbage if served
  // as text. Treat as binary (hexdump) rather than mislabel it. A UTF-16 body
  // is usually caught by the NUL scan below anyway (ASCII encodes as NN 00).
  if (buf.length >= 2) {
    const b0 = buf[0]!;
    const b1 = buf[1]!;
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return true;
  }
  let control = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0) return true;
    // Allow common text control bytes: tab, LF, FF, CR.
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 12 && b !== 13) control++;
  }
  return control / buf.length > 0.3;
}

/** Classify a filename into how it should be surfaced to the agent. */
export function classifyKind(name: string): UploadKind {
  const ext = path.extname(name).toLowerCase();
  if (ext in IMAGE_EXTS) return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'binary';
}
