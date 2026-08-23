/** How a file should be shown, and which language to highlight it in. */

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

/** 'html' and 'markdown' have a rendered form, so they get the source toggle. */
export type PreviewKind = 'image' | 'pdf' | 'html' | 'markdown' | 'text';

export function previewKind(name: string): PreviewKind {
  const lower = name.toLowerCase();
  // Same rule as path.extname: a leading dot is a dotfile, not an extension.
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return 'text';
}

/** Map file extension to shiki language id. */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonl: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  zig: 'zig',
  lua: 'lua',
  tex: 'latex',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  dockerfile: 'docker',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  jsonc: 'json',
  svg: 'xml',
  vue: 'vue',
  svelte: 'svelte',
  env: 'ini',
  proto: 'proto',
  graphql: 'graphql',
};

/** As above but for a path, and always a usable shiki id: unknown highlights as plain text. */
export function langFromPath(path: string): string {
  return langFromFilename(path.trim().split('/').pop() ?? '') || 'text';
}

/** Empty when the extension is unknown, so a caller can skip highlighting entirely. */
export function langFromFilename(name: string): string {
  const lower = name.toLowerCase();
  // Extensionless files with well-known names.
  if (lower === 'dockerfile') return 'docker';
  if (lower === 'makefile') return 'make';
  const ext = lower.split('.').pop() ?? '';
  return EXT_TO_LANG[ext] ?? '';
}
