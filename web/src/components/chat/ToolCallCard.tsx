import { useEffect, useState, type ReactNode, type TransitionEvent } from 'react';
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
import { MarkdownRenderer } from './MarkdownRenderer.js';

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
    case 'websearch':
    case 'introspect': {
      const q = str(inp.query) ?? str(inp.doc_path);
      return q ? { text: q } : null;
    }
    case 'webfetch': {
      const u = str(inp.url);
      if (!u) return null;
      let host = u;
      try {
        host = new URL(u).hostname || u;
      } catch {
        // not a parseable URL; show it as-is
      }
      return { text: host, title: u };
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
        <span className={`toolcall-chevron ${open ? 'is-open' : ''}`}>&#9656;</span>
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

      <Collapse open={open}>
        <div className="toolcall-body">{renderBody(tool)}</div>
      </Collapse>
    </div>
  );
}

/**
 * Height transition for expanding/collapsing content. Uses the grid-rows
 * 0fr -> 1fr trick so it animates to the content's natural height without
 * measuring. The body stays lazily mounted: it mounts on first open and
 * unmounts again once the closing transition finishes, so collapsed tool calls
 * still don't pay for highlighting until opened.
 */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  const onTransitionEnd = (e: TransitionEvent) => {
    if (e.propertyName === 'grid-template-rows' && !open) setMounted(false);
  };
  return (
    <div className={`collapse ${open ? 'is-open' : ''}`} onTransitionEnd={onTransitionEnd}>
      <div className="collapse-inner">{mounted ? children : null}</div>
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
    case 'webfetch':
      return renderWebFetch(tool);
    case 'websearch':
      return renderWebSearch(tool);
    case 'introspect':
      return renderIntrospect(tool);
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
    // A read-kind tool without file text - show it generically rather than
    // leaving the body empty.
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

/** introspect: show the query, then render the `documentation` as markdown.
 *  The result is JSON ({ documentation, query_context }); the docs read far
 *  better rendered than as an escaped JSON blob (which is what the generic
 *  view produces, since the two-field object defeats soleStringField). */
function renderIntrospect(tool: ToolCallView): ReactNode {
  const inp = asObj(tool.input);
  const query = str(inp?.query) ?? str(inp?.doc_path);
  const blocks = toolBlocks(tool);
  const j = firstJsonData(blocks);
  const doc = (j ? (str(j.documentation) ?? soleStringField(j)) : null) ?? outputText(blocks);
  return (
    <>
      {query && (
        <div className="toolcall-section">
          <div className="toolcall-label">query</div>
          <Code code={query} lang="text" />
        </div>
      )}
      {doc.trim() ? (
        <div className="toolcall-doc">
          <MarkdownRenderer text={doc} />
        </div>
      ) : (
        renderGeneric(tool)
      )}
    </>
  );
}

/** web_fetch: a clickable source URL (+ mode tag / search terms), then the
 *  fetched page content rendered as markdown. */
function renderWebFetch(tool: ToolCallView): ReactNode {
  const inp = asObj(tool.input);
  const url = str(inp?.url);
  const mode = str(inp?.mode);
  const terms = str(inp?.search_terms);
  const blocks = toolBlocks(tool);
  const j = firstJsonData(blocks);
  const content = j
    ? (soleStringField(j) ?? str(j.content) ?? JSON.stringify(j, null, 2))
    : outputText(blocks);
  return (
    <>
      {url && (
        <div className="toolcall-meta">
          <a className="toolcall-link" href={url} target="_blank" rel="noopener noreferrer">
            {url}
          </a>
          {mode && <span className="toolcall-tag">{mode}</span>}
        </div>
      )}
      {terms && (
        <div className="toolcall-section">
          <div className="toolcall-label">search terms</div>
          <Code code={terms} lang="text" />
        </div>
      )}
      {content.trim() ? (
        <div className="toolcall-doc">
          <MarkdownRenderer text={content} />
        </div>
      ) : (
        renderGeneric(tool)
      )}
    </>
  );
}

interface SearchHit {
  title?: string;
  url?: string;
  snippet?: string;
}

/** Pull a list of {title,url,snippet} from web_search output regardless of the
 *  envelope key (results/items/data, or a bare array), tolerating the common
 *  field-name variants. */
function searchHits(j: Record<string, unknown> | null): SearchHit[] | null {
  if (!j) return null;
  const arr = Array.isArray(j.results)
    ? j.results
    : Array.isArray(j.items)
      ? j.items
      : Array.isArray(j.data)
        ? j.data
        : null;
  if (!arr) return null;
  const hits: SearchHit[] = [];
  for (const it of arr) {
    const o = asObj(it);
    if (!o) continue;
    hits.push({
      title: str(o.title) ?? str(o.name),
      url: str(o.url) ?? str(o.link) ?? str(o.href),
      snippet: str(o.snippet) ?? str(o.description) ?? str(o.content) ?? str(o.text),
    });
  }
  return hits.length ? hits : null;
}

/** web_search: the query, then a compact list of result hits (title links +
 *  snippets). Falls back to the generic view when results aren't structured. */
function renderWebSearch(tool: ToolCallView): ReactNode {
  const blocks = toolBlocks(tool);
  const hits = searchHits(firstJsonData(blocks));
  if (!hits) return renderGeneric(tool);
  const query = str(asObj(tool.input)?.query);
  return (
    <>
      {query && (
        <div className="toolcall-section">
          <div className="toolcall-label">query</div>
          <Code code={query} lang="text" />
        </div>
      )}
      <ol className="websearch">
        {hits.map((h, i) => (
          <li key={i} className="websearch-item">
            {h.url ? (
              <a className="websearch-title" href={h.url} target="_blank" rel="noopener noreferrer">
                {h.title ?? h.url}
              </a>
            ) : (
              <span className="websearch-title">{h.title ?? '(untitled)'}</span>
            )}
            {h.url && <div className="websearch-url">{h.url}</div>}
            {h.snippet && <p className="websearch-snippet">{h.snippet}</p>}
          </li>
        ))}
      </ol>
    </>
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
