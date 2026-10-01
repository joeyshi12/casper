import { memo, useEffect, useState, type ReactNode } from 'react';
import { Collapse } from './Collapse.js';
import { useStore, type ToolCallView } from '../../state/store.js';
import { workspaceRelative } from '../../util/workspacePath.js';
import { highlightToHtml } from '../../util/highlighter.js';
import { lineDiff, type DiffLine } from '../../util/diff.js';
import { lazyImageProps } from '../../util/lazyImage.js';
import {
  classifyTool,
  firstDiff,
  firstJsonData,
  langFromPath,
  outputText,
  parseTodo,
  soleStringField,
  toolBlocks,
  toolPhrase,
  runSummary,
} from '../../util/toolRender.js';
import { ChevronIcon } from '../common/icons.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { prettyWidgetTitle, widgetCallOf } from '../../util/widgetCall.js';
import { choiceCallOf } from '../../util/choiceCall.js';
import { isSubagentCall } from '../../util/subagentCall.js';
import { ChoiceTemplate } from './ChoiceTemplate.js';
import { WidgetBlock } from './WidgetBlock.js';
import { SubagentToolCall } from './SubagentToolCall.js';

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

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
  `/api/fs/file?path=${encodeURIComponent(absolutePath)}`;

const imageChecks = new Map<string, Promise<boolean>>();
function imageExists(path: string): Promise<boolean> {
  let check = imageChecks.get(path);
  if (!check) {
    check = fetch(imageUrl(path), { method: 'HEAD' })
      .then((r) => r.ok && (r.headers.get('content-type') ?? '').startsWith('image/'))
      .catch(() => false);
    imageChecks.set(path, check);
  }
  return check;
}

function useExistingImages(paths: string[]): string[] | null {
  const key = paths.join('\n');
  const [found, setFound] = useState<{ key: string; paths: string[] } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const list = key.split('\n');
    void Promise.all(list.map(imageExists)).then((ok) => {
      if (!cancelled) setFound({ key, paths: list.filter((_, i) => ok[i]) });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  if (!key) return [];
  return found?.key === key ? found.paths : null;
}

function useToolContent(tool: ToolCallView): { images: string[]; body: ReactNode; hidden: boolean } {
  const paths = extractImagePaths(tool.input);
  const existing = useExistingImages(paths);
  const images = existing ?? paths;
  const body = renderBody(tool);
  const hidden = paths.length > 0 && existing !== null && existing.length === 0 && body == null;
  return { images, body, hidden };
}

interface ToolCallCardProps {
  tool: ToolCallView;
  arriving?: boolean;
  active?: boolean;
}

/** A widget, choice, or subagent list is dispatched here rather than inside the body,
 *  since the body holds hook state and must not change hook count mid-stream. */
function ToolCallCardBody({ tool, arriving, active }: ToolCallCardProps) {
  if (isSubagentCall(tool)) return <SubagentToolCall tool={tool} />;
  const widget = widgetCallOf(tool);
  if (widget) {
    if (tool.status === 'failed') {
      return (
        <div className="widget-error">
          Widget {prettyWidgetTitle(widget.title) || 'call'} failed.
        </div>
      );
    }
    return widget.code ? <WidgetBlock code={widget.code} /> : null;
  }
  const choice = choiceCallOf(tool);
  if (choice) return <ChoiceTemplate data={choice} toolId={tool.id} />;
  return <GenericToolCall tool={tool} arriving={arriving} active={active} />;
}

function ToolImages({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="toolcall-images">
      {paths.map((p) => (
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
            {...lazyImageProps}
          />
        </a>
      ))}
    </div>
  );
}

function GenericToolCall({ tool, arriving = false, active = false }: ToolCallCardProps) {
  const status = tool.status;
  const [open, setOpen] = useState(false);
  const { images, body, hidden } = useToolContent(tool);
  const hasBody = body != null || images.length > 0;
  if (hidden) return null;

  return (
    <div className={`toolline-wrap ${arriving ? 'is-arriving' : ''}`}>
      <ToolLine
        text={toolPhrase(tool, status === 'in_progress')}
        detail={searchQuery(tool)}
        live={status === 'in_progress' || (active && status !== 'failed')}
        failed={status === 'failed'}
        open={open}
        onToggle={hasBody ? () => setOpen((o) => !o) : undefined}
      />
      {hasBody && (
        <Collapse open={open}>
          <div className="toolcall-body">
            <ToolImages paths={images} />
            {body}
          </div>
        </Collapse>
      )}
    </div>
  );
}

function ToolLine({
  text,
  detail,
  live,
  failed,
  open,
  onToggle,
}: {
  text: string;
  detail?: string;
  live: boolean;
  failed: boolean;
  open: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      <span className={`toolline-text ${live ? 'is-live' : ''}`}>{text}</span>
      {detail && <span className="toolline-detail">{detail}</span>}
      {onToggle && (
        <span className={`toolline-chevron ${open ? 'is-open' : ''}`}>
          <ChevronIcon size={13} />
        </span>
      )}
    </>
  );
  const className = `toolline ${failed ? 'is-failed' : ''}`;
  return onToggle ? (
    <button className={className} onClick={onToggle} aria-expanded={open}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

export type RunRowInput =
  | { kind: 'tool'; tool: ToolCallView }
  | { kind: 'thought'; text: string };

/** `liveThought`, when given, is the streaming thought still arriving, appended as a
 *  trailing row; while present the group's line reads "Thinking" unless a tool call
 *  is also running, whose own phrase takes priority. */
function ToolCallGroup({
  rows,
  liveThought,
  arriving = false,
  active = false,
}: {
  rows: RunRowInput[];
  liveThought?: string;
  arriving?: boolean;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const tools = rows.flatMap((r) => (r.kind === 'tool' ? [r.tool] : []));
  const liveTool = tools.find((t) => t.status === 'in_progress');
  const text = liveTool
    ? toolPhrase(liveTool, true)
    : liveThought !== undefined
      ? 'Thinking'
      : runSummary(tools);
  const live = !!liveTool || liveThought !== undefined || active;

  return (
    <div className={`toolline-wrap ${arriving ? 'is-arriving' : ''}`}>
      <ToolLine text={text} live={live} failed={false} open={open} onToggle={() => setOpen((o) => !o)} />
      <Collapse open={open}>
        <div className="toolline-box">
          {[
            ...rows.map((row, i) =>
              row.kind === 'tool' ? (
                <ToolCallRow key={row.tool.id} tool={row.tool} />
              ) : (
                <ThoughtRow key={`thought-${i}`} text={row.text} />
              ),
            ),
            ...(liveThought !== undefined
              ? [<ThoughtRow key={`thought-${rows.length}`} text={liveThought} live />]
              : []),
          ]}
        </div>
      </Collapse>
    </div>
  );
}

function ToolCallRow({ tool }: { tool: ToolCallView }) {
  const status = tool.status;
  const [open, setOpen] = useState(false);
  const { images, body, hidden } = useToolContent(tool);
  const hasBody = body != null || images.length > 0;
  if (hidden) return null;

  return (
    <div className="toolline-row">
      <ToolLine
        text={toolPhrase(tool, status === 'in_progress')}
        detail={searchQuery(tool)}
        live={status === 'in_progress'}
        failed={status === 'failed'}
        open={open}
        onToggle={hasBody ? () => setOpen((o) => !o) : undefined}
      />
      {hasBody && (
        <Collapse open={open}>
          <div className="toolcall-body">
            <ToolImages paths={images} />
            {body}
          </div>
        </Collapse>
      )}
    </div>
  );
}

function ThoughtRow({ text, live = false }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!live && !text.trim()) return null;
  return (
    <div className="toolline-row">
      <ToolLine text="Thinking" live={live} failed={false} open={open} onToggle={() => setOpen((o) => !o)} />
      <Collapse open={open}>
        <div className="toolcall-body">
          <div className="thought-text">{text}</div>
        </div>
      </Collapse>
    </div>
  );
}

function ThoughtLine({
  text,
  live = false,
  arriving = false,
}: {
  text: string;
  live?: boolean;
  arriving?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!live && !text.trim()) return null;
  return (
    <div className={`toolline-wrap ${arriving ? 'is-arriving' : ''}`}>
      <ToolLine text="Thinking" live={live} failed={false} open={open} onToggle={() => setOpen((o) => !o)} />
      <Collapse open={open}>
        <div className="toolcall-body">
          <div className="thought-text">{text}</div>
        </div>
      </Collapse>
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
    <div className="shell-panel">
      {cmd && (
        <>
          <div className="shell-label">bash</div>
          <Code code={cmd} lang="bash" />
        </>
      )}
      {stdout.trim() && (
        <>
          <div className="shell-label">Output</div>
          <Code code={stdout} lang="text" />
        </>
      )}
      {stderr.trim() && (
        <>
          <div className="shell-label">Errors</div>
          <Code code={stderr} lang="text" />
        </>
      )}
      {failed && <div className="toolcall-exit">{exit}</div>}
    </div>
  );
}

/* Clickable only when the file is inside the workspace: the preview endpoint is
   confined to the session cwd. */
function FileHeading({ path }: { path: string }) {
  const activeId = useStore((s) => s.activeId);
  const cwd = useStore((s) => s.chats.find((x) => x.chatId === s.activeId)?.cwd ?? '');
  const openFilePreview = useStore((s) => s.openFilePreview);
  const relative = activeId ? workspaceRelative(cwd, path) : null;
  const shown = relative ?? path;

  if (!relative) {
    return (
      <div className="toolcall-file" title={path}>
        <span className="toolcall-file-name is-plain">{shown}</span>
      </div>
    );
  }
  return (
    <div className="toolcall-file">
      <button
        className="toolcall-file-name"
        onClick={() => openFilePreview(relative)}
        title={`Preview ${path}`}
      >
        {shown}
      </button>
    </div>
  );
}

function renderWrite(tool: ToolCallView): ReactNode {
  const inp = asObj(tool.input);
  const path = str(inp?.path) ?? '';
  const withPath = (body: ReactNode): ReactNode =>
    path ? (
      <>
        <FileHeading path={path} />
        {body}
      </>
    ) : (
      body
    );
  const command = str(inp?.command);
  if (command === 'create' || command === 'insert') {
    const content = str(inp?.content);
    if (content !== undefined) return withPath(<Code code={content} lang={langFromPath(path)} />);
  }
  const oldStr = str(inp?.oldStr);
  const newStr = str(inp?.newStr);
  if (oldStr !== undefined && newStr !== undefined) {
    return withPath(<DiffView diff={lineDiff(oldStr, newStr)} />);
  }
  const d = firstDiff(tool.content);
  if (d) return withPath(<DiffView diff={lineDiff(d.oldText, d.newText)} />);
  return withPath(renderGeneric(tool));
}

function renderRead(tool: ToolCallView): ReactNode {
  const inp = asObj(tool.input);
  const ops = inp && Array.isArray(inp.operations) ? inp.operations : [];
  const text = outputText(toolBlocks(tool));
  if (!text.trim()) {
    if (extractImagePaths(tool.input).length > 0) return null;
    return renderGeneric(tool);
  }
  const textOp = ops.map(asObj).find((o) => o && o.mode !== 'Image');
  const path = textOp && typeof textOp.path === 'string' ? textOp.path : '';
  const lang = textOp?.mode === 'Line' ? langFromPath(path) : 'text';
  return (
    <>
      {path && <FileHeading path={path} />}
      <Code code={text} lang={lang} />
    </>
  );
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
  if (!tasks) return renderGeneric(tool);
  if (tasks.length === 0) return <div className="todo-empty">All tasks done.</div>;
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
          <div className="toolcall-label">Query</div>
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
          <div className="toolcall-label">Search terms</div>
          <Code code={terms} lang="text" />
        </div>
      )}
      {content.trim() ? (
        <Code code={content} lang="markdown" />
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

function renderWebSearch(tool: ToolCallView): ReactNode {
  const blocks = toolBlocks(tool);
  const hits = searchHits(firstJsonData(blocks));
  if (!hits) return renderGeneric(tool);
  return (
    <ul className="websearch">
      {hits.map((h, i) => {
        const site = hostOf(h.url);
        const title = h.title ?? h.url ?? '(untitled)';
        return (
          <li key={i}>
            {h.url ? (
              <a className="websearch-row" href={h.url} target="_blank" rel="noopener noreferrer" title={h.url}>
                <span className="websearch-title">{title}</span>
                {site && <span className="websearch-site">{site}</span>}
              </a>
            ) : (
              <span className="websearch-row">
                <span className="websearch-title">{title}</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function searchQuery(tool: ToolCallView): string | undefined {
  if (classifyTool(tool) !== 'websearch') return undefined;
  const inp = asObj(tool.input);
  if (str(inp?.__tool_use_purpose)) return undefined;
  return str(inp?.query);
}

function renderGeneric(tool: ToolCallView): ReactNode {
  const input = tool.input;
  let inputStr = '';
  if (typeof input === 'string') {
    inputStr = input;
  } else if (asObj(input)) {
    const { __tool_use_purpose, ...rest } = asObj(input)!;
    void __tool_use_purpose;
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
          <div className="toolcall-label">Input</div>
          <Code code={inputStr} lang={asObj(input) ? 'json' : 'text'} />
        </div>
      )}
      {outStr.trim() && (
        <div className="toolcall-section">
          <div className="toolcall-label">Output</div>
          <Code code={outStr} lang={outLang} />
        </div>
      )}
    </>
  );
}

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

/* Memoized: the transcript re-renders on every streamed chunk, and the store
   replaces only the tool object that changed, so other cards' props stay identical. */
export const ToolCallCard = memo(ToolCallCardBody);

/** Memoized for the same reason as ToolCallCard. */
export const ToolCallGroupCard = memo(ToolCallGroup);

export const ThoughtLineCard = memo(ThoughtLine);
