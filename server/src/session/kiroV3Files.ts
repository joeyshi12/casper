import fs from 'node:fs/promises';
import path from 'node:path';
import { kiroToolName, SUBAGENT_TOOL, type KiroUpdateMeta, type TranscriptToolCall } from '@casper/shared';
import { config } from '../config.js';
import { isValidSessionId } from '../util/paths.js';
import type { PersistedSession, TranscriptEntry } from './kiroFiles.js';
import { v2SessionsDir } from './kiroV2Files.js';

// Reads kiro V3's session store: <sessions>/<workspace hash>/<id>/session.json for the
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
// How much of the end of messages.jsonl is searched for the latest context usage.
const CONTEXT_TAIL_BYTES = 256 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function iso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** The workspace directories of the V3 store, skipping the V2 store and kiro's indexes. */
async function workspaceDirs(): Promise<string[]> {
  const root = config.kiroSessionsDir;
  const v2 = v2SessionsDir();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(root, e.name))
      .filter((d) => d !== v2);
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

/** The latest context usage kiro recorded, from the end of messages.jsonl. */
async function lastContextUsage(file: string): Promise<number | undefined> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, CONTEXT_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    if (length < size) lines.shift(); // cut mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"contextUsage"')) continue;
      try {
        const p = (JSON.parse(line) as V3Line).payload;
        const value = isRecord(p.value) ? p.value.usagePercentage : undefined;
        if (p.type === 'session_metadata' && p.key === 'contextUsage' && typeof value === 'number') return value;
      } catch {
        /* not a complete line */
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

export async function readV3Session(
  dir: string,
  opts: { contextUsage?: boolean } = {},
): Promise<PersistedSession | null> {
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
    contextUsagePercentage: opts.contextUsage
      ? await lastContextUsage(path.join(dir, 'messages.jsonl'))
      : undefined,
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

  for (const line of await readLines(file)) {
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
          // A call kiro copied in from a kiro 2.x session has no kind, only 2.x's tool name.
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
