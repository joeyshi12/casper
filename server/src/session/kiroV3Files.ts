import fs from 'node:fs/promises';
import path from 'node:path';
import { kiroToolName, SUBAGENT_TOOL, type KiroUpdateMeta, type TranscriptToolCall } from '@casper/shared';
import { config } from '../config.js';
import { isValidSessionId } from '../util/paths.js';
import type { PersistedSession, TranscriptEntry } from './kiroFiles.js';

// Reads kiro's session store: <sessions>/<workspace hash>/<id>/session.json for the
// metadata, messages.jsonl for the conversation, and sub-executions/<id>.jsonl for each
// subagent. kiro owns these files; Casper only reads them, and deletes a chat's.

interface V3SessionJson {
  id: string;
  title?: string;
  agentMode?: string;
  modelId?: string;
  workspacePaths?: string[];
  createdAt?: string;
  lastModifiedAt?: string;
}

/** One line of messages.jsonl. */
interface V3Line {
  id: string;
  timestamp?: string;
  payload: Record<string, unknown> & { type?: string };
}

// kiro's title for a session it has not named yet.
const PLACEHOLDER_TITLE = 'New Session';
// kiro writes hidden reasoning as this placeholder plus an encrypted signature.
const HIDDEN_REASONING = '...';
// How much of the end of messages.jsonl is searched for the latest context usage, and how
// much is read at a time.
const CONTEXT_TAIL_BYTES = 1024 * 1024;
const CONTEXT_CHUNK_BYTES = 16 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function iso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

// kiro 2.x's store, which kiro 3.x leaves in place. It holds directories named by session
// id too, and V3 copies of the same sessions, so it must not be read as a workspace.
const V2_STORE = 'cli';

/** The workspace directories of the store, skipping kiro's indexes. */
async function workspaceDirs(): Promise<string[]> {
  const root = config.kiroSessionsDir;
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== V2_STORE)
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/** Every V3 session directory by session id, for reading many sessions at once. */
export async function v3SessionDirs(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    (await workspaceDirs()).map(async (dir) => {
      try {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith('.') && isValidSessionId(e.name)) {
            out.set(e.name, path.join(dir, e.name));
          }
        }
      } catch {
        /* a workspace directory removed while listing */
      }
    }),
  );
  return out;
}

/** One session's V3 directory, or undefined if kiro V3 has no such session. kiro names
 *  the workspace directory after a hash of the cwd it first saw, which a later cwd
 *  change does not move, so every workspace is checked. */
export async function v3SessionDir(sessionId: string): Promise<string | undefined> {
  if (!isValidSessionId(sessionId)) return undefined;
  const found = await Promise.all(
    (await workspaceDirs()).map(async (dir) => {
      const candidate = path.join(dir, sessionId);
      try {
        await fs.access(path.join(candidate, 'session.json'));
        return candidate;
      } catch {
        return undefined;
      }
    }),
  );
  return found.find((d) => d !== undefined);
}

/** The context usage on one line of messages.jsonl, if it records one. */
function contextUsageOf(line: string): number | undefined {
  if (!line.includes('"contextUsage"')) return undefined;
  try {
    const p = (JSON.parse(line) as V3Line).payload;
    const value = isRecord(p.value) ? p.value.usagePercentage : undefined;
    return p.type === 'session_metadata' && p.key === 'contextUsage' && typeof value === 'number' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The latest context usage kiro recorded. kiro writes it several times a turn, so it is
 *  read backwards from the end of messages.jsonl a chunk at a time, up to a limit. */
async function lastContextUsage(file: string): Promise<number | undefined> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = await handle.stat();
    let end = size;
    let tail = '';
    while (end > 0 && size - end < CONTEXT_TAIL_BYTES) {
      const start = Math.max(0, end - CONTEXT_CHUNK_BYTES);
      const buf = Buffer.alloc(end - start);
      await handle.read(buf, 0, buf.length, start);
      end = start;
      const lines = (buf.toString('utf8') + tail).split('\n');
      // The first line may start before this chunk, unless the chunk starts the file.
      tail = end > 0 ? lines.shift()! : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const value = contextUsageOf(lines[i]!);
        if (value !== undefined) return value;
      }
    }
    return tail ? contextUsageOf(tail) : undefined;
  } finally {
    await handle.close();
  }
}

export async function readV3Session(dir: string): Promise<PersistedSession | null> {
  let j: V3SessionJson;
  try {
    j = JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8')) as V3SessionJson;
  } catch {
    return null;
  }
  const title = j.title?.trim() ?? '';
  const createdAt = iso(j.createdAt) ?? new Date(0).toISOString();
  return {
    sessionId: j.id,
    title: title === PLACEHOLDER_TITLE ? '' : title,
    cwd: j.workspacePaths?.[0] ?? '',
    createdAt,
    updatedAt: iso(j.lastModifiedAt) ?? createdAt,
    agentId: j.agentMode,
    modelId: j.modelId,
    contextUsagePercentage: await lastContextUsage(path.join(dir, 'messages.jsonl')),
  };
}

async function readLines(file: string, filter?: string): Promise<V3Line[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: V3Line[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim() || (filter && !line.includes(filter))) continue;
    try {
      const parsed = JSON.parse(line) as V3Line;
      if (isRecord(parsed) && isRecord(parsed.payload) && typeof parsed.id === 'string') out.push(parsed);
    } catch {
      /* a malformed line is skipped */
    }
  }
  return out;
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('');
}

/** A tool result as the content blocks the web renders, minus inline images. */
function resultBlocks(content: unknown): unknown[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) return content.filter((b) => !(isRecord(b) && b.type === 'image'));
  return isRecord(content) ? [{ kind: 'json', data: content }] : [];
}

const START_SUFFIX = '-sub-agent-start';
const COMPLETE_SUFFIX = '-sub-agent-complete';

/**
 * Whether a line repeats one already read. When kiro copies in a kiro 2.x session, after
 * each compaction it writes again the turns 2.x had kept in context, each under the id
 * `compact_<summary id>_<id of the line it repeats>`.
 */
function isCompactionCopy(id: string, seen: Set<string>): boolean {
  if (!id.startsWith('compact_')) return false;
  const rest = id.slice('compact_'.length);
  const sep = rest.indexOf('_');
  return sep >= 0 && seen.has(rest.slice(sep + 1));
}

/** The entries of one V3 conversation file: a session's messages.jsonl or a subagent's
 *  sub-executions file. Timestamps are milliseconds. kiro records no tool call for the
 *  call that starts a subagent, only its start and its result, so one is built from
 *  those under the live call's id. */
export async function readV3Entries(file: string): Promise<TranscriptEntry[]> {
  const out: TranscriptEntry[] = [];
  const toolsById = new Map<string, TranscriptToolCall>();
  const addTool = (tool: TranscriptToolCall) => {
    const seen = toolsById.get(tool.id);
    if (seen) {
      Object.assign(seen, { ...tool, content: seen.content, output: seen.output ?? tool.output });
      return;
    }
    toolsById.set(tool.id, tool);
    out.push({ kind: 'item', item: { type: 'tool_call', tool } });
  };

  const seen = new Set<string>();
  for (const line of await readLines(file)) {
    const copy = isCompactionCopy(line.id, seen);
    seen.add(line.id);
    if (copy) continue;
    const p = line.payload;
    const parsed = line.timestamp ? Date.parse(line.timestamp) : NaN;
    const at = Number.isNaN(parsed) ? undefined : parsed;

    switch (p.type) {
      case 'user':
        out.push({ kind: 'prompt', id: line.id, text: userText(p.content), atMs: at, timestamp: at });
        break;
      case 'assistant': {
        const text = str(p.content) ?? '';
        if (!text.trim()) break;
        if (p.operationType === 'Summary') {
          out.push({ kind: 'item', item: { type: 'compaction', id: `c-${line.id}`, summary: text, timestamp: at } });
        } else if (p.operationType === 'Reasoning') {
          if (text.trim() !== HIDDEN_REASONING) {
            out.push({ kind: 'item', item: { type: 'message', message: { id: `t-${line.id}`, role: 'thinking', text: text.trim(), timestamp: at } } });
          }
        } else {
          out.push({ kind: 'item', item: { type: 'message', message: { id: `a-${line.id}`, role: 'assistant', text, timestamp: at } } });
        }
        break;
      }
      case 'tool_call': {
        const id = str(p.toolCallId);
        if (!id) break;
        const title = str(p.title);
        const meta = isRecord(p._meta) ? (p._meta as { kiro?: KiroUpdateMeta }) : undefined;
        // An MCP call is stored as kiro's `tool_call` tool wrapping the real arguments.
        const args = p.args;
        const input = p.toolName === 'tool_call' && isRecord(args) && 'arguments' in args ? args.arguments : args;
        addTool({
          id,
          // A call kiro copied in from a kiro 2.x session has no kind, only 2.x's tool name,
          // which the web renders by.
          name: kiroToolName({ title, _meta: meta }) ?? (p.kind === undefined ? str(p.toolName) : undefined),
          title: title ?? str(p.toolName) ?? id,
          kind: str(p.kind),
          status: p.status === 'failed' ? 'failed' : 'completed',
          input,
          content: [],
        });
        break;
      }
      case 'tool_result': {
        const tool = toolsById.get(str(p.toolCallId) ?? '');
        if (!tool) break;
        tool.status = p.success === false ? 'failed' : 'completed';
        tool.content = resultBlocks(p.content);
        break;
      }
      case 'sub_agent_start': {
        const name = str(p.subAgentName) ?? 'subagent';
        addTool({
          id: line.id.endsWith(START_SUFFIX) ? line.id.slice(0, -START_SUFFIX.length) : line.id,
          name: SUBAGENT_TOOL,
          title: `Sub-agent: ${name}`,
          kind: 'other',
          // Without a result the parent turn ended while the subagent ran.
          status: 'failed',
          input: { name, prompt: str(p.prompt), explanation: str(p.explanation) },
          content: [],
        });
        break;
      }
      case 'sub_agent_complete': {
        const tool = toolsById.get(line.id.endsWith(COMPLETE_SUFFIX) ? line.id.slice(0, -COMPLETE_SUFFIX.length) : '');
        if (!tool) break;
        tool.status = p.status === 'success' ? 'completed' : 'failed';
        tool.output = str(p.response);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** One subagent a V3 session started, as recorded in its messages.jsonl. */
export interface SubExecution {
  sessionId: string;
  name: string;
  toolCallId: string;
  status: 'completed' | 'failed';
  /** Set when the subagent never reported back, so its parent turn ended under it. */
  stopped: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The subagents a V3 session started, oldest first. */
export async function readSubExecutions(dir: string): Promise<SubExecution[]> {
  const byId = new Map<string, SubExecution>();
  for (const line of await readLines(path.join(dir, 'messages.jsonl'), '"sub_agent_')) {
    const p = line.payload;
    const subId = str(p.subSessionId);
    if (!subId) continue;
    const at = iso(line.timestamp) ?? new Date(0).toISOString();
    if (p.type === 'sub_agent_start') {
      byId.set(subId, {
        sessionId: subId,
        name: str(p.subAgentName) ?? subId,
        toolCallId: line.id.endsWith(START_SUFFIX) ? line.id.slice(0, -START_SUFFIX.length) : line.id,
        status: 'failed',
        stopped: true,
        createdAt: at,
        updatedAt: at,
      });
    } else if (p.type === 'sub_agent_complete') {
      const sub = byId.get(subId);
      if (!sub) continue;
      sub.status = p.status === 'success' ? 'completed' : 'failed';
      sub.stopped = false;
      sub.updatedAt = at;
    }
  }
  return [...byId.values()];
}

/** A subagent's own conversation file, or undefined for an id that cannot name one. */
export function subExecutionFile(dir: string, subagentId: string): string | undefined {
  return isValidSessionId(subagentId) ? path.join(dir, 'sub-executions', `${subagentId}.jsonl`) : undefined;
}
