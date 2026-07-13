import type { Highlighter } from 'shiki';

/**
 * Lazily create a single Shiki highlighter shared across all consumers
 * (code blocks in messages and the file-tree preview). Creating one per
 * component would load the WASM + grammars twice.
 */
let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['aurora-x'],
        langs: [
          'typescript', 'javascript', 'tsx', 'jsx', 'json', 'bash',
          'python', 'rust', 'go', 'java', 'yaml', 'markdown', 'html',
          'css', 'sql', 'diff', 'latex', 'zig', 'c', 'cpp', 'csharp',
          'ruby', 'php', 'kotlin', 'swift', 'toml', 'lua', 'dockerfile',
          'xml', 'ini', 'make',
        ],
      }),
    );
  }
  return highlighterPromise;
}
