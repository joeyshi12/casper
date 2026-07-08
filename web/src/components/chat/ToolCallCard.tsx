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

/** An MCP / agent tool invocation, with collapsible input + output. */
export function ToolCallCard({ tool }: { tool: ToolCallView }) {
  const [open, setOpen] = useState(tool.status === 'failed');
  const status = tool.status;
  const input = stringify(tool.input);
  const output =
    stringify(tool.output) ||
    tool.content.map((c) => stringify(c)).filter(Boolean).join('\n');

  return (
    <div className={`toolcall toolcall-${status}`}>
      <button className="toolcall-head" onClick={() => setOpen((o) => !o)}>
        <span className={`toolcall-dot dot-${status}`} />
        <span className="toolcall-title">{tool.title}</span>
        <span className="toolcall-status">{STATUS_LABEL[status] ?? status}</span>
        <span className="toolcall-chevron">{open ? '▾' : '▸'}</span>
      </button>
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
