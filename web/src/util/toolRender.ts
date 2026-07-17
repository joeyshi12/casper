// Pure helpers for rendering tool calls. They normalize the several content
// shapes kiro produces - persisted {kind,data} blocks, live ACP
// {type:'content',content:{text}} blocks, and live {type:'diff'} edit blocks -
// into simple values the renderers consume. Unit-tested.

type Block = Record<string, unknown>;

const isObj = (v: unknown): v is Block => !!v && typeof v === 'object';

type ToolKind = 'shell' | 'write' | 'read' | 'grep' | 'todo' | 'generic';

/**
 * Which specialized renderer handles a tool call. Prefer the canonical tool
 * name (kiro's _meta.kiro.toolName live, or the persisted name on hydrate),
 * which is identical across live and reload. Fall back to kind + input shape
 * only for older data that lacks a name.
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
  return 'generic';
}

/**
 * A canonical tool label for the header, consistent whether the call is live or
 * hydrated. Prefer the real tool name (identical across both); else derive from
 * the classified kind, then a single-token title, then "tool".
 */
export function toolLabel(tool: { name?: string; title?: string; kind?: string; input?: unknown }): string {
  if (tool.name) return tool.name;
  const k = classifyTool(tool);
  if (k === 'todo') return 'todo_list';
  if (k !== 'generic') return k; // shell / write / read / grep
  const t = tool.title ?? '';
  return t && !/\s/.test(t) ? t : 'tool';
}

/** Shiki language id from a file path's extension (falls back to 'text'). */
export function langFromPath(path: string): string {
  const base = path.trim().split('/').pop() ?? '';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : base.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
    xml: 'xml', svg: 'xml', vue: 'vue', svelte: 'svelte', md: 'markdown', markdown: 'markdown',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', sh: 'bash', bash: 'bash', zsh: 'bash',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql', php: 'php', swift: 'swift', lua: 'lua',
    dockerfile: 'docker', ini: 'ini', conf: 'ini', env: 'ini', proto: 'proto', graphql: 'graphql',
  };
  return map[ext] ?? 'text';
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
