export { langFromPath } from './fileKind.js';

// Normalizes kiro's content shapes - persisted {kind,data} blocks, live ACP
// {type:'content',content:{text}} blocks, and live {type:'diff'} edit blocks -
// into values the renderers consume.

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

/** Which specialized renderer handles a tool call. Prefers the canonical tool name;
 *  live ACP updates can arrive without one, so the heuristics below are not legacy. */
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
  if (tool.name) return 'generic';

  const inp = isObj(tool.input) ? tool.input : {};
  const k = tool.kind;
  const cmd = typeof inp.command === 'string' ? inp.command : undefined;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(inp, key);

  // todo_list disambiguated from write (which shares the `create` command) by task-list keys.
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
  // grep has `pattern`; kind 'search' also covers web_search (which has `query` instead).
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
  // `url` is unique to web_fetch; web_search and introspect both carry `query`,
  // so lean on kind/title to tell them apart.
  if (typeof inp.url === 'string') return 'webfetch';
  if (typeof inp.query === 'string' && (k === 'search' || tool.title === 'web_search')) return 'websearch';
  if (tool.title === 'introspect' || typeof inp.doc_path === 'string') return 'introspect';
  return 'generic';
}

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
const IN_TITLE = /@([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/;

/* An MCP tool as "@server/tool", or null. Live, kiro sends the tool name bare and
   puts the namespace only in the title, so the title must be checked against the
   name first: a shell command like "npm i @casper/web" would otherwise look like one. */
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

export function toolPhrase(tool: ToolLike, live: boolean): string {
  const inp = isObj(tool.input) ? tool.input : null;
  const purpose = inp ? str(inp.__tool_use_purpose) : undefined;
  if (purpose) return purpose;
  const kind = classifyTool(tool);
  const [past, present] = KIND_VERB[kind];
  const target = toolTarget(tool, kind);
  const verb = live ? present : past;
  if (!target) {
    if (kind === 'shell') return live ? 'Running a command' : 'Ran a command';
    return verb;
  }
  return `${verb} ${target}`;
}

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

export function runSummary(tools: ToolLike[]): string {
  return tools.length > 0 ? toolRunSummary(tools) : 'Thought';
}

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

export function firstJsonData(content: unknown[]): Record<string, unknown> | null {
  for (const b of content) {
    if (isObj(b) && b.kind === 'json' && isObj(b.data)) return b.data;
  }
  return null;
}

export function soleStringField(data: Record<string, unknown>): string | null {
  const keys = Object.keys(data);
  return keys.length === 1 && typeof data[keys[0]!] === 'string'
    ? (data[keys[0]!] as string)
    : null;
}

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

export function toolBlocks(tool: { content?: unknown[]; output?: unknown }): unknown[] {
  const content = Array.isArray(tool.content) ? tool.content : [];
  return [...content, ...outputToBlocks(tool.output)];
}

interface DiffContent {
  path?: string;
  oldText: string;
  newText: string;
}

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
