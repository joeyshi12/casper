import fs from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptToolCall } from '@casper/shared';
import { config } from '../config.js';
import { isValidSessionId } from '../util/paths.js';
import type { ChildSession, PersistedSession, TranscriptEntry } from './kiroFiles.js';

// Reads the session files kiro-cli 2.x wrote (<sessions>/cli/<id>.{json,jsonl}). kiro V3
// copies a V2 session into its own store the first time it loads it, so these are only
// read for chats that have not been opened since kiro moved to V3, and for their
// subagents.

export function v2SessionsDir(): string {
  return path.join(config.kiroSessionsDir, 'cli');
}

interface KiroMetering {
  value: number;
  unit: string;
  unitPlural: string;
}

interface KiroTurnMetadata {
  metering_usage?: KiroMetering[];
  context_usage_percentage?: number;
}

interface KiroSessionJson {
  session_id: string;
  cwd: string;
  created_at: string;
  updated_at: string;
  title?: string;
  parent_session_id?: string;
  session_created_reason?: string;
  session_state?: {
    agent_name?: string;
    rts_model_state?: {
      model_info?: { model_id?: string; context_window_tokens?: number };
      context_usage_percentage?: number;
    };
    conversation_metadata?: {
      user_turn_metadatas?: KiroTurnMetadata[];
    };
  };
}

// A content block is always {kind, data}; kept loose and narrowed with runtime
// guards, since a `kind: string` catch-all widens `data` back to unknown.
interface KiroContentBlock {
  kind: string;
  data: unknown;
}

interface KiroToolUseData {
  toolUseId: string;
  name?: string;
  input?: unknown;
}
interface KiroToolResultData {
  toolUseId: string;
  status?: string;
  content?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isContentBlock(v: unknown): v is KiroContentBlock {
  return isRecord(v) && typeof v.kind === 'string';
}

/** The `data` of a `toolUse` block, or null if it isn't one. */
function toolUseData(b: KiroContentBlock): KiroToolUseData | null {
  if (b.kind !== 'toolUse' || !isRecord(b.data)) return null;
  const { toolUseId, name, input } = b.data;
  if (typeof toolUseId !== 'string') return null;
  return { toolUseId, name: typeof name === 'string' ? name : undefined, input };
}

/** The `data` of a `toolResult` block, or null if it isn't one. */
function toolResultData(b: KiroContentBlock): KiroToolResultData | null {
  if (b.kind !== 'toolResult' || !isRecord(b.data)) return null;
  const { toolUseId, status, content } = b.data;
  if (typeof toolUseId !== 'string') return null;
  return { toolUseId, status: typeof status === 'string' ? status : undefined, content };
}

interface KiroJsonlEntry {
  kind: string;
  data: {
    message_id?: string;
    content?: unknown;
    meta?: { timestamp?: number };
    summary?: string;
  };
}

/** The well-formed {kind, data} blocks of an entry, skipping anything malformed. */
function contentBlocks(content: unknown): KiroContentBlock[] {
  return Array.isArray(content) ? content.filter(isContentBlock) : [];
}

function blockText(c: KiroContentBlock): string {
  if (typeof c.data === 'string') return c.data;
  if (isRecord(c.data) && typeof c.data.text === 'string') return c.data.text;
  return '';
}

/** Tool-result blocks worth sending, minus inline images: kiro stores those as a
 *  raw byte array (one page measured 5.1 MB vs ~100 KB without), and nothing
 *  renders them anyway. */
function renderableBlocks(content: unknown): KiroContentBlock[] {
  return contentBlocks(content).filter((b) => b.kind !== 'image');
}

function summarize(j: KiroSessionJson): PersistedSession {
  const state = j.session_state;
  const turns = state?.conversation_metadata?.user_turn_metadatas ?? [];
  const contextUsagePercentage =
    state?.rts_model_state?.context_usage_percentage ??
    turns[turns.length - 1]?.context_usage_percentage;

  return {
    sessionId: j.session_id,
    title: j.title?.trim() ?? '',
    cwd: j.cwd,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    agentId: state?.agent_name,
    modelId: state?.rts_model_state?.model_info?.model_id,
    contextUsagePercentage,
  };
}

/** Deletes <id>.{json,jsonl,history,lock} and the per-session <id>/ dir. .lock is
 *  kiro's "active in another process" marker. */
export async function deleteV2Session(sessionId: string): Promise<void> {
  const dir = v2SessionsDir();
  const targets = [
    path.join(dir, `${sessionId}.json`),
    path.join(dir, `${sessionId}.jsonl`),
    path.join(dir, `${sessionId}.history`),
    path.join(dir, `${sessionId}.lock`),
    path.join(dir, sessionId),
  ];
  await Promise.all(targets.map((f) => fs.rm(f, { recursive: true, force: true })));
}

export async function readV2Session(sessionId: string): Promise<PersistedSession | null> {
  try {
    const raw = await fs.readFile(path.join(v2SessionsDir(), `${sessionId}.json`), 'utf8');
    return summarize(JSON.parse(raw) as KiroSessionJson);
  } catch {
    return null;
  }
}

/* kiro stops updating a child's .json updated_at seconds after it starts; the .jsonl is
   written on every turn, so its mtime is when the subagent last did anything. */
async function withLastWrite(child: ChildSession): Promise<ChildSession> {
  try {
    const st = await fs.stat(path.join(v2SessionsDir(), `${child.sessionId}.jsonl`));
    const mtime = st.mtime.toISOString();
    return mtime > child.updatedAt ? { ...child, updatedAt: mtime } : child;
  } catch {
    return child;
  }
}

/** One child session of the given parent, or null if it is missing or belongs elsewhere. */
export async function readChildSession(childSessionId: string, parentSessionId: string): Promise<ChildSession | null> {
  if (!isValidSessionId(childSessionId)) return null;
  try {
    const raw = await fs.readFile(path.join(v2SessionsDir(), `${childSessionId}.json`), 'utf8');
    const j = JSON.parse(raw) as KiroSessionJson;
    return j.parent_session_id === parentSessionId ? await withLastWrite({ ...summarize(j), parentSessionId }) : null;
  } catch {
    return null;
  }
}

export async function listChildSessions(parentSessionId: string): Promise<ChildSession[]> {
  if (!isValidSessionId(parentSessionId)) return [];
  const dir = v2SessionsDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ChildSession[] = [];
  await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (n) => {
        try {
          const raw = await fs.readFile(path.join(dir, n), 'utf8');
          const j = JSON.parse(raw) as KiroSessionJson;
          if (j.parent_session_id === parentSessionId) {
            out.push(await withLastWrite({ ...summarize(j), parentSessionId }));
          }
        } catch {
          /* unreadable or malformed file; skip it */
        }
      }),
  );
  return out;
}

/** A session's jsonl as parsed entries, skipping blank and malformed lines. */
async function readJsonlEntries(sessionId: string): Promise<KiroJsonlEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(v2SessionsDir(), `${sessionId}.jsonl`), 'utf8');
  } catch {
    return [];
  }
  const entries: KiroJsonlEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as KiroJsonlEntry);
    } catch {
      /* a malformed line is skipped */
    }
  }
  return entries;
}

/** Whether kiro has recorded any conversation for this session; a 0-byte jsonl means
 *  no, and kiro refuses to load such a session. Verified against kiro 2.11. */
export async function v2HasRecordedTurns(sessionId: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(v2SessionsDir(), `${sessionId}.jsonl`));
    return st.size > 0;
  } catch {
    return false;
  }
}

/** The transcript entries of a V2 session. Tool uses live in AssistantMessage content;
 *  their results arrive in a later ToolResults entry, matched back by toolUseId. kiro
 *  stamps a prompt in whole seconds, so `timestamp` is in seconds here. */
export async function readV2Entries(sessionId: string): Promise<TranscriptEntry[]> {
  const out: TranscriptEntry[] = [];
  const toolsById = new Map<string, TranscriptToolCall>();

  for (const entry of await readJsonlEntries(sessionId)) {
    const content = contentBlocks(entry.data.content);
    const textOf = (kind: string) =>
      content.filter((c) => c.kind === kind).map(blockText).join('');
    const baseId = entry.data.message_id ?? `${out.length}`;
    const ts = entry.data.meta?.timestamp;
    const push = (item: TranscriptEntry) => out.push(item);

    if (entry.kind === 'Prompt') {
      push({
        kind: 'prompt',
        id: baseId,
        text: textOf('text'),
        atMs: ts === undefined ? undefined : ts * 1000,
        timestamp: ts,
      });
    } else if (entry.kind === 'AssistantMessage') {
      const thinking = textOf('thinking');
      if (thinking.trim()) {
        push({ kind: 'item', item: { type: 'message', message: { id: `t-${baseId}`, role: 'thinking', text: thinking.trim(), timestamp: ts } } });
      }
      const text = textOf('text');
      if (text.trim()) {
        push({ kind: 'item', item: { type: 'message', message: { id: `a-${baseId}`, role: 'assistant', text, timestamp: ts } } });
      }
      for (const c of content) {
        const d = toolUseData(c);
        if (!d) continue;
        // Completed by default; ToolResults may override it.
        const tool: TranscriptToolCall = {
          id: d.toolUseId,
          name: d.name,
          title: d.name ?? d.toolUseId,
          status: 'completed',
          input: d.input,
          content: [],
        };
        toolsById.set(d.toolUseId, tool);
        push({ kind: 'item', item: { type: 'tool_call', tool } });
      }
    } else if (entry.kind === 'ToolResults') {
      for (const c of content) {
        const d = toolResultData(c);
        if (!d) continue;
        const tool = toolsById.get(d.toolUseId);
        if (!tool) continue;
        tool.status = d.status === 'error' ? 'failed' : 'completed';
        tool.content = renderableBlocks(d.content);
      }
    } else if (entry.kind === 'Compaction') {
      const summary = entry.data.summary ?? '';
      if (summary.trim()) {
        push({ kind: 'item', item: { type: 'compaction', id: `c-${baseId}`, summary, timestamp: ts } });
      }
    }
  }
  return out;
}
