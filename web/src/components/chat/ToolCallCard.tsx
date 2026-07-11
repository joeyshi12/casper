import { useState } from 'react';
import type { ToolCallView } from '../../state/store.js';

const STATUS_LABEL: Record<string, string> = {
  pending: 'queued',
  in_progress: 'running',
  completed: 'done',
  failed: 'failed',
};

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Extract image paths from a tool call's input (the `read` tool with Image mode). */
function extractImagePaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const obj = input as Record<string, unknown>;

  // Shape: { operations: [{ mode: "Image", image_paths: [...] }] }
  const ops = obj.operations;
  if (!Array.isArray(ops)) return [];

  const paths: string[] = [];
  for (const op of ops) {
    if (
      op &&
      typeof op === 'object' &&
      (op as Record<string, unknown>).mode === 'Image' &&
      Array.isArray((op as Record<string, unknown>).image_paths)
    ) {
      for (const p of (op as Record<string, unknown>).image_paths as unknown[]) {
        if (typeof p === 'string') paths.push(p);
      }
    }
  }
  return paths;
}

/** Build the URL to serve an image through the server. */
function imageUrl(absolutePath: string): string {
  return `/api/fs/image?path=${encodeURIComponent(absolutePath)}`;
}

/** An MCP / agent tool invocation, with collapsible input + output. */
export function ToolCallCard({ tool }: { tool: ToolCallView }) {
  const [open, setOpen] = useState(tool.status === 'failed');
  const status = tool.status;
  const input = stringify(tool.input);
  const output =
    stringify(tool.output) ||
    tool.content.map((c) => stringify(c)).filter(Boolean).join('\n');

  const imagePaths = extractImagePaths(tool.input);

  return (
    <div className={`toolcall toolcall-${status}`}>
      <button className="toolcall-head" onClick={() => setOpen((o) => !o)}>
        <span className={`toolcall-dot dot-${status}`} />
        <span className="toolcall-title">{tool.title}</span>
        <span className="toolcall-status">{STATUS_LABEL[status] ?? status}</span>
        <span className="toolcall-chevron">{open ? '▾' : '▸'}</span>
      </button>

      {/* Render images inline (always visible, not collapsed). */}
      {imagePaths.length > 0 && (
        <div className="toolcall-images">
          {imagePaths.map((p) => (
            <a
              key={p}
              href={imageUrl(p)}
              target="_blank"
              rel="noopener noreferrer"
              className="toolcall-image-link"
            >
              <img
                src={imageUrl(p)}
                alt={p.split('/').pop() ?? 'image'}
                className="toolcall-image"
                loading="lazy"
              />
            </a>
          ))}
        </div>
      )}

      {open && (
        <div className="toolcall-body">
          {input && (
            <div className="toolcall-section">
              <div className="toolcall-label">input</div>
              <pre className="toolcall-pre">{input}</pre>
            </div>
          )}
          {output && (
            <div className="toolcall-section">
              <div className="toolcall-label">output</div>
              <pre className="toolcall-pre">{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
