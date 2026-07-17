import { useEffect, useState, type ReactNode } from 'react';
import type { ToolCallView } from '../../state/store.js';
import { highlightToHtml } from '../../util/highlighter.js';
import { lineDiff, type DiffLine } from '../../util/diff.js';
import {
  classifyTool,
  firstDiff,
  firstJsonData,
  langFromPath,
  outputText,
  parseTodo,
  soleStringField,
  toolBlocks,
  toolLabel,
} from '../../util/toolRender.js';

const STATUS_LABEL: Record<string, string> = {
  pending: 'queued',
  in_progress: 'running',
  completed: 'done',
  failed: 'failed',
};

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const base = (p: string): string => p.split('/').pop() || p;

/** The first readable path from a `read` tool's operations. */
function readPath(input: Record<string, unknown>): string | undefined {
  const ops = Array.isArray(input.operations) ? input.operations : [];
  for (const op of ops) {
    const o = asObj(op);
    if (o && typeof o.path === 'string') return o.path;
    if (o && Array.isArray(o.image_paths) && typeof o.image_paths[0] === 'string') {
      return o.image_paths[0];
    }
  }
  return undefined;
}

/** Concise header subtitle: the agent's stated purpose (preferred), else a
 *  filename / pattern. Never the shell command - those are long 1-liners. */
function summaryOf(tool: ToolCallView): { text: string; title?: string } | null {
  const inp = asObj(tool.input);
  if (!inp) return null;
  const purpose = str(inp.__tool_use_purpose);
  if (purpose) return { text: purpose };
  switch (classifyTool(tool)) {
    case 'write': {
      const p = str(inp.path);
      return p ? { text: base(p), title: p } : null;
    }
    case 'read': {
      const p = readPath(inp);
      return p ? { text: base(p), title: p } : null;
    }
    case 'grep': {
      const p = str(inp.pattern);
      return p ? { text: p } : null;
    }
    default:
      return null;
  }
}

function extractImagePaths(input: unknown): string[] {
  const obj = asObj(input);
  if (!obj || !Array.isArray(obj.operations)) return [];
  const paths: string[] = [];
  for (const op of obj.operations) {
    const o = asObj(op);
    if (o && o.mode === 'Image' && Array.isArray(o.image_paths)) {
      for (const p of o.image_paths) if (typeof p === 'string') paths.push(p);
    }
  }
  return paths;
}

const imageUrl = (absolutePath: string) =>
  `/api/fs/image?path=${encodeURIComponent(absolutePath)}`;

/**
 * A tool invocation. Common tools get a tailored, syntax-highlighted body
 * (shell -> command + output, writes -> diff or full file, read -> file
 * contents, grep -> matches); anything else falls back to a generic
 * input/output view. Collapsed by default (failures start open) with an
 * informative header so the transcript stays compact.
 */
export function ToolCallCard({ tool }: { tool: ToolCallView }) {
  const status = tool.status;
  const [open, setOpen] = useState(status === 'failed');
  const summary = summaryOf(tool);
  const imagePaths = extractImagePaths(tool.input);

  return (
    <div className={`toolcall toolcall-${status}`}>
      <button className="toolcall-head" onClick={() => setOpen((o) => !o)}>
        <span className={`toolcall-dot dot-${status}`} />
        <span className="toolcall-title">{toolLabel(tool)}</span>
        {summary && (
          <span className="toolcall-summary" title={summary.title ?? summary.text}>
            {summary.text}
          </span>
        )}
        <span className="toolcall-status">{STATUS_LABEL[status] ?? status}</span>
        <span className="toolcall-chevron">{open ? '▾' : '▸'}</span>
      </button>

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

      {open && <div className="toolcall-body">{renderBody(tool)}</div>}
    </div>
  );
}

function renderBody(tool: ToolCallView): ReactNode {
  switch (classifyTool(tool)) {
    case 'shell':
      return renderShell(tool);
    case 'write':
      return renderWrite(tool);
    case 'read':
      return renderRead(tool);
    case 'grep':
      return renderGrep(tool);
    case 'todo':
      return renderTodo(tool);
    default:
      return renderGeneric(tool);
  }
}

function renderShell(tool: ToolCallView): ReactNode {
  const inp = asObj(tool.input);
  const cmd = str(inp?.command) ?? '';
  const blocks = toolBlocks(tool);
  const j = firstJsonData(blocks);
  const stdout = j ? (str(j.stdout) ?? '') : outputText(blocks);
  const stderr = j ? (str(j.stderr) ?? '') : '';
  const exit = j ? String(j.exit_status ?? '') : '';
  const failed = exit !== '' && !/\b0$/.test(exit);
  return (
    <>
      {cmd && <Code code={cmd} lang="bash" />}
      {stdout.trim() && <Code code={stdout} lang="text" />}
      {stderr.trim() && (
        <div className="toolcall-section">
          <div className="toolcall-label">stderr</div>
          <Code code={stderr} lang="text" />
        </div>
      )}
      {failed && <div className="toolcall-exit">{exit}</div>}
    </>
  );
}

function renderWrite(tool: ToolCallView): ReactNode {
  const inp = asObj(tool.input);
  const path = str(inp?.path) ?? '';
  const command = str(inp?.command);
  // New file / inserted content: show the whole thing highlighted by extension.
  if (command === 'create' || command === 'insert') {
    const content = str(inp?.content);
    if (content !== undefined) return <Code code={content} lang={langFromPath(path)} />;
  }
  // strReplace (the `write` tool or the standalone one): diff old -> new.
  const oldStr = str(inp?.oldStr);
  const newStr = str(inp?.newStr);
  if (oldStr !== undefined && newStr !== undefined) {
    return <DiffView diff={lineDiff(oldStr, newStr)} />;
  }
  // Live edit streamed as a diff block before the input is available.
  const d = firstDiff(tool.content);
  if (d) return <DiffView diff={lineDiff(d.oldText, d.newText)} />;
  return renderGeneric(tool);
}

function renderRead(tool: ToolCallView): ReactNode {
  const inp = asObj(tool.input);
  const ops = inp && Array.isArray(inp.operations) ? inp.operations : [];
  const text = outputText(toolBlocks(tool));
  if (!text.trim()) {
    // Image-only read: the image renders in the card header, nothing more.
    if (extractImagePaths(tool.input).length > 0) return null;
    // A read-kind tool without file text (e.g. introspect returns JSON) - show
    // it generically rather than leaving the body empty.
    return renderGeneric(tool);
  }
  const textOp = ops.map(asObj).find((o) => o && o.mode !== 'Image');
  const path = textOp && typeof textOp.path === 'string' ? textOp.path : '';
  const lang = textOp?.mode === 'Line' ? langFromPath(path) : 'text';
  return <Code code={text} lang={lang} />;
}

function renderGrep(tool: ToolCallView): ReactNode {
  const blocks = toolBlocks(tool);
  const j = firstJsonData(blocks);
  const results =
    j && Array.isArray(j.results)
      ? j.results.filter((r) => {
          const o = asObj(r);
          return !!o && (Array.isArray(o.matches) || typeof o.file === 'string');
        })
      : null;
  if (results && results.length > 0) {
    return (
      <div className="grep">
        {results.map((r, i) => {
          const o = asObj(r);
          const file = o && typeof o.file === 'string' ? o.file : '';
          const matches = o && Array.isArray(o.matches) ? o.matches.map(String) : [];
          return (
            <div key={i} className="grep-file">
              <div className="grep-fname">{file}</div>
              <pre className="grep-matches">{matches.join('\n')}</pre>
            </div>
          );
        })}
      </div>
    );
  }
  const text = outputText(blocks);
  if (text.trim()) return <Code code={text} lang="text" />;
  return renderGeneric(tool);
}

function renderTodo(tool: ToolCallView): ReactNode {
  const tasks = parseTodo(toolBlocks(tool));
  if (!tasks || tasks.length === 0) return renderGeneric(tool);
  return (
    <div className="todo">
      {tasks.map((t, i) => (
        <div key={i} className={`todo-item ${t.done ? 'is-done' : ''}`}>
          <span className="todo-check" aria-hidden>
            {t.done ? '☑' : '☐'}
          </span>
          <span className="todo-text">{t.desc}</span>
        </div>
      ))}
    </div>
  );
}

function renderGeneric(tool: ToolCallView): ReactNode {
  const input = tool.input;
  let inputStr = '';
  if (typeof input === 'string') {
    inputStr = input;
  } else if (asObj(input)) {
    const { __tool_use_purpose, ...rest } = asObj(input)!;
    void __tool_use_purpose; // excluded from the dump; shown in the header subtitle
    inputStr = JSON.stringify(rest, null, 2);
  }
  const blocks = toolBlocks(tool);
  const j = firstJsonData(blocks);
  const soleStr = j ? soleStringField(j) : null;
  const outStr = soleStr ?? (j ? JSON.stringify(j, null, 2) : outputText(blocks));
  const outLang = soleStr ? 'text' : /^\s*[[{]/.test(outStr) ? 'json' : 'text';
  return (
    <>
      {inputStr && inputStr !== '{}' && (
        <div className="toolcall-section">
          <div className="toolcall-label">input</div>
          <Code code={inputStr} lang={asObj(input) ? 'json' : 'text'} />
        </div>
      )}
      {outStr.trim() && (
        <div className="toolcall-section">
          <div className="toolcall-label">output</div>
          <Code code={outStr} lang={outLang} />
        </div>
      )}
    </>
  );
}

/** Syntax-highlighted code with no surrounding chrome (bar/border), so it reads
 *  as colored text inside the tool card rather than a nested window. */
function Code({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    highlightToHtml(code, lang)
      .then((out) => !cancelled && setHtml(out))
      .catch(() => !cancelled && setHtml(null));
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  return html ? (
    <div className="toolcode" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <pre className="toolcode toolcode-plain">{code}</pre>
  );
}

/** Red/green line diff for a file edit. */
function DiffView({ diff }: { diff: DiffLine[] }) {
  return (
    <div className="diff-body">
      {diff.map((l, i) => (
        <div key={i} className={`diff-line diff-${l.type}`}>
          <span className="diff-sign" aria-hidden>
            {l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}
          </span>
          <span className="diff-code">{l.text || '\u00a0'}</span>
        </div>
      ))}
    </div>
  );
}
