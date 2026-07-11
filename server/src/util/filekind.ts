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

export function isImageExt(ext: string): boolean {
  return ext.toLowerCase() in IMAGE_EXTS;
}

/** Classify a filename into how it should be surfaced to the agent. */
export function classifyKind(name: string): UploadKind {
  const ext = path.extname(name).toLowerCase();
  if (ext in IMAGE_EXTS) return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'binary';
}
