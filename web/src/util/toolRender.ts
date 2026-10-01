export { langFromPath } from './fileKind.js';

// Pure helpers for rendering tool calls. They normalize the several content
// shapes kiro produces - persisted {kind,data} blocks, live ACP
// {type:'content',content:{text}} blocks, and live {type:'diff'} edit blocks -
// into simple values the renderers consume. Unit-tested.

type Block = Record<string, unknown>;

const isObj = (v: unknown): v is Block => !!v && typeof v === 'object';

type ToolKind =
  | 'shell'
  | 'write'
  | 'read'
  | 'grep'
  | 'todo'
  | 'webfetch'
  | 'websearch'
  | 'introspect'
  | 'generic';

/**
 * Which specialized renderer handles a tool call. Prefer the canonical tool name (kiro's
 * _meta.kiro.toolName live, the persisted name on hydrate), which is identical either way.
 *
 * The kind + input heuristics below are not legacy: live ACP updates can arrive without
 * that name, and the tests pin live and hydrated output to the same result.
 */
export function classifyTool(tool: { name?: string; title?: string; kind?: string; input?: unknown }): ToolKind {
  switch (tool.name) {
    case 'shell':
      return 'shell';
    case 'write':
    case 'strReplace':
      return 'write';
    case 'read':
      return 'read';
    case 'grep':
      return 'grep';
    case 'todo_list':
      return 'todo';
    case 'web_fetch':
      return 'webfetch';
    case 'web_search':
      return 'websearch';
    case 'introspect':
      return 'introspect';
  }
  if (tool.name) return 'generic'; // a known tool with no specialized renderer

  const inp = isObj(tool.input) ? tool.input : {};
  const k = tool.kind;
  const cmd = typeof inp.command === 'string' ? inp.command : undefined;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(inp, key);

  // todo_list has no ACP kind; identify by its command/keys (create is shared
  // with write, so it's disambiguated by the task-list keys below).
  if (
    tool.title === 'todo_list' ||
    has('tasks') ||
    has('task_list_description') ||
    has('completed_task_ids') ||
    has('remove_task_ids') ||
    (cmd !== undefined && ['complete', 'add', 'remove', 'list'].includes(cmd))
  ) {
    return 'todo';
  }
  if (k === 'read' || Array.isArray(inp.operations) || tool.title === 'read') return 'read';
  // grep specifically has a `pattern`. kind 'search' also covers web_search
  // (which has a `query` instead) - that falls through to the generic view.
  if (tool.title === 'grep' || (typeof inp.pattern === 'string' && !has('operations'))) {
    return 'grep';
  }
  if (
    k === 'edit' ||
    tool.title === 'write' ||
    tool.title === 'strReplace' ||
    ((cmd === 'create' || cmd === 'strReplace' || cmd === 'insert') && typeof inp.path === 'string') ||
    (typeof inp.oldStr === 'string' && typeof inp.newStr === 'string')
  ) {
    return 'write';
  }
  if (k === 'execute' || tool.title === 'shell' || typeof inp.command === 'string') return 'shell';
  // Name-less fallbacks for the web / introspect tools. `url` is unique to
  // web_fetch; web_search vs introspect both carry a `query`, so lean on
  // kind/title to disambiguate.
  if (typeof inp.url === 'string') return 'webfetch';
  if (typeof inp.query === 'string' && (k === 'search' || tool.title === 'web_search')) return 'websearch';
  if (tool.title === 'introspect' || typeof inp.doc_path === 'string') return 'introspect';
  return 'generic';
}

/**
 * A canonical tool label for the header, consistent whether the call is live or
 * hydrated. Prefer the real tool name (identical across both); else derive from
 * the classified kind, then a single-token title, then "tool".
 */
const KIND_LABEL: Record<ToolKind, string | undefined> = {
  shell: 'shell',
  write: 'write',
  read: 'read',
  grep: 'grep',
  todo: 'todo_list',
  webfetch: 'web_fetch',
  websearch: 'web_search',
  introspect: 'introspect',
  generic: undefined,
};

/** A namespaced MCP tool, as "server/tool" or "@server/tool". */
const NAMESPACED = /^@?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
/** kiro's own rendering of one, e.g. "Running: @casper/show_widget". */
const IN_TITLE = /@([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/;

/**
 * An MCP tool as "@server/tool", or null when it is not one. Live, kiro sends the tool name
 * bare and puts the namespace only in the title, so the server has to come from there. The
 * title is matched against the name before it is trusted, because a shell command can carry
 * something that looks like one: "Running: npm i @casper/web" is the shell tool.
 */
function mcpLabel(tool: { name?: string; title?: string }): string | null {
  const named = NAMESPACED.exec(tool.name ?? '');
  if (named) return `@${named[1]}/${named[2]}`;
  const titled = IN_TITLE.exec(tool.title ?? '');
  if (!titled) return null;
  if (tool.name && tool.name !== titled[2]) return null;
  return `@${titled[1]}/${titled[2]}`;
}

export function toolLabel(tool: { name?: string; title?: string; kind?: string; input?: unknown }): string {
  const mcp = mcpLabel(tool);
  if (mcp) return mcp;
  if (tool.name) return tool.name;
  const mapped = KIND_LABEL[classifyTool(tool)];
  if (mapped) return mapped;
  const t = tool.title ?? '';
  return t && !/\s/.test(t) ? t : 'tool';
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const baseName = (p: string): string => p.split('/').pop() || p;

/** The first readable path from a `read` tool's operations (file or image). */
function readTarget(input: Block): string | undefined {
  const ops = Array.isArray(input.operations) ? input.operations : [];
  for (const op of ops) {
    const o = isObj(op) ? op : null;
    if (o && typeof o.path === 'string') return o.path;
    if (o && Array.isArray(o.image_paths) && typeof o.image_paths[0] === 'string') {
      return o.image_paths[0];
    }
  }
  return undefined;
}

/** Past and present tense verbs for a tool kind, used when there is no target
 *  to name ("Ran a command") and as the lead word when there is ("Read x.ts"). */
const KIND_VERB: Record<ToolKind, [string, string]> = {
  shell: ['Ran', 'Running'],
  write: ['Wrote', 'Writing'],
  read: ['Read', 'Reading'],
  grep: ['Searched', 'Searching'],
  todo: ['Updated the task list', 'Updating the task list'],
  webfetch: ['Fetched', 'Fetching'],
  websearch: ['Searched the web', 'Searching the web'],
  introspect: ['Looked up', 'Looking up'],
  generic: ['Ran a tool', 'Running a tool'],
};

export type ToolLike = { name?: string; title?: string; kind?: string; input?: unknown };

/** The target a kind's verb acts on, e.g. a filename or a search pattern. Undefined
 *  when the kind has no single target (shell, generic) or none was found. */
function toolTarget(tool: ToolLike, kind: ToolKind): string | undefined {
  const inp = isObj(tool.input) ? tool.input : null;
  if (!inp) return undefined;
  switch (kind) {
    case 'write': {
      const p = str(inp.path);
      return p ? baseName(p) : undefined;
    }
    case 'read': {
      const p = readTarget(inp);
      return p ? baseName(p) : undefined;
    }
    case 'grep':
      return str(inp.pattern);
    case 'introspect':
      return str(inp.query) ?? str(inp.doc_path);
    case 'webfetch': {
      const u = str(inp.url);
      if (!u) return undefined;
      try {
        return new URL(u).hostname || u;
      } catch {
        return u;
      }
    }
    default:
      return undefined;
  }
}

/**
 * One line of text for a tool call: the agent's own `__tool_use_purpose` when it gave one,
 * else a plain phrase built from the tool kind and its target. Past tense when done, present
 * tense ("Running a command") while the call is still in progress - the caller picks tense
 * by passing `live`.
 */
export function toolPhrase(tool: ToolLike, live: boolean): string {
  const inp = isObj(tool.input) ? tool.input : null;
  const purpose = inp ? str(inp.__tool_use_purpose) : undefined;
  if (purpose) return purpose;
  const kind = classifyTool(tool);
  const [past, present] = KIND_VERB[kind];
  const target = toolTarget(tool, kind);
  const verb = live ? present : past;
  if (!target) {
    // "Running"/"Ran" alone reads as a command specifically; the other kinds already
    // say what they did ("Searching the web").
    if (kind === 'shell') return live ? 'Running a command' : 'Ran a command';
    return verb;
  }
  return `${verb} ${target}`;
}

/** Plain noun phrase for a kind with no target, used in a run's summary line
 *  ("Ran a command, read 2 files"). Singular / plural(n). */
const KIND_NOUN: Record<ToolKind, [string, (n: number) => string]> = {
  shell: ['ran a command', (n) => `ran ${n} commands`],
  write: ['wrote a file', (n) => `wrote ${n} files`],
  read: ['read a file', (n) => `read ${n} files`],
  grep: ['searched the code', (n) => `searched the code ${n} times`],
  todo: ['updated the task list', (n) => `updated the task list ${n} times`],
  webfetch: ['fetched a page', (n) => `fetched ${n} pages`],
  websearch: ['searched the web', (n) => `searched the web ${n} times`],
  introspect: ['looked something up', (n) => `looked up ${n} things`],
  generic: ['ran a tool', (n) => `ran ${n} tools`],
};

/** The closed summary line for a run of two or more tool calls, grouped by kind and counted:
 *  "Ran a command, read 2 files". Capitalised, in the kinds' first-seen order. */
export function toolRunSummary(tools: ToolLike[]): string {
  const order: ToolKind[] = [];
  const counts = new Map<ToolKind, number>();
  for (const tool of tools) {
    const kind = classifyTool(tool);
    if (!counts.has(kind)) order.push(kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const phrases = order.map((kind) => {
    const n = counts.get(kind)!;
    const [one, many] = KIND_NOUN[kind];
    return n === 1 ? one : many(n);
  });
  const joined = phrases.join(', ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** The closed summary line for a run that may mix thinking messages and tool calls.
 *  Thinking adds nothing to the text once there is a tool call to describe - the tool
 *  calls are the part worth naming. A run with no tool calls at all, only thoughts,
 *  reads "Thought". */
export function runSummary(tools: ToolLike[]): string {
  return tools.length > 0 ? toolRunSummary(tools) : 'Thought';
}

/** Concatenated plain text from a tool call's content, across shapes:
 *  ACP {type:'content',content:{text}}, {type:'text',text}, persisted
 *  {kind:'text',data}. (JSON blocks are handled by firstJsonData.) */
export function outputText(content: unknown[]): string {
  const parts: string[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'content' && isObj(b.content) && typeof b.content.text === 'string') {
      parts.push(b.content.text);
    } else if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.kind === 'text' && typeof b.data === 'string') {
      parts.push(b.data);
    }
  }
  return parts.join('');
}

/** The first persisted JSON block's data (shell result, grep results). */
export function firstJsonData(content: unknown[]): Record<string, unknown> | null {
  for (const b of content) {
    if (isObj(b) && b.kind === 'json' && isObj(b.data)) return b.data;
  }
  return null;
}

/** If a JSON object carries exactly one string field (e.g. introspect's
 *  { documentation }), return that string - it reads far better as text than
 *  as escaped JSON. Otherwise null. */
export function soleStringField(data: Record<string, unknown>): string | null {
  const keys = Object.keys(data);
  return keys.length === 1 && typeof data[keys[0]!] === 'string'
    ? (data[keys[0]!] as string)
    : null;
}

/** kiro's live rawOutput ({items:[{Text}|{Json}]}, or a plain string) turned
 *  into content-like blocks, so the same extractors work on live output as on
 *  the persisted {kind,data} content. */
export function outputToBlocks(output: unknown): unknown[] {
  if (output == null) return [];
  if (typeof output === 'string') return output ? [{ kind: 'text', data: output }] : [];
  if (isObj(output) && Array.isArray(output.items)) {
    const out: unknown[] = [];
    for (const it of output.items) {
      if (!isObj(it)) continue;
      if (typeof it.Text === 'string') out.push({ kind: 'text', data: it.Text });
      else if (isObj(it.Json)) out.push({ kind: 'json', data: it.Json });
    }
    return out;
  }
  return [];
}

/** All renderable blocks for a tool: its content plus its normalized output.
 *  Live results arrive in output (rawOutput); persisted ones in content. */
export function toolBlocks(tool: { content?: unknown[]; output?: unknown }): unknown[] {
  const content = Array.isArray(tool.content) ? tool.content : [];
  return [...content, ...outputToBlocks(tool.output)];
}

interface DiffContent {
  path?: string;
  oldText: string;
  newText: string;
}

/** The first live ACP diff block ({type:'diff', path, oldText, newText}). */
export function firstDiff(content: unknown[]): DiffContent | null {
  for (const b of content) {
    if (isObj(b) && b.type === 'diff' && typeof b.oldText === 'string' && typeof b.newText === 'string') {
      return {
        path: typeof b.path === 'string' ? b.path : undefined,
        oldText: b.oldText,
        newText: b.newText,
      };
    }
  }
  return null;
}

interface TodoTask {
  desc: string;
  done: boolean;
}

/** The task list from a todo_list result: a persisted {kind:'json'} block, or
 *  a live text block whose JSON we parse. The result always carries the full
 *  current list regardless of the command (create/complete/add/remove/list). */
export function parseTodo(content: unknown[]): TodoTask[] | null {
  let data: Block | null = firstJsonData(content);
  if (!data || !Array.isArray(data.tasks)) {
    const text = outputText(content).trim();
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        data = isObj(parsed) ? parsed : null;
      } catch {
        data = null;
      }
    }
  }
  if (data && Array.isArray(data.tasks)) {
    return data.tasks.map((x) => {
      const o = isObj(x) ? x : {};
      return {
        desc: typeof o.task_description === 'string' ? o.task_description : '',
        done: o.completed === true,
      };
    });
  }
  return null;
}
