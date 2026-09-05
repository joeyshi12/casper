import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  TranscriptItem,
  TranscriptMessage,
  TranscriptToolCall,
} from '@casper/shared';
import { stripAttachmentsLine } from '@casper/shared';
import type { MessageAttachment } from '@casper/shared';
import { config } from '../config.js';
import { isValidSessionId } from '../util/paths.js';

/**
 * Reads kiro-cli's own on-disk session persistence
 * (~/.kiro/sessions/cli/<id>.{json,jsonl}) so Casper can list and hydrate
 * DORMANT sessions without spawning a process.
 */

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

// A content block is always {kind, data}, but `data`'s shape depends on `kind` and kiro emits
// kinds we don't model. A union with a `kind: string` catch-all doesn't work: checking
// `kind === 'text'` leaves the catch-all in play, so `data` widens back to unknown and every
// read needs a cast. Keep the block loose and narrow it with the runtime guards below.
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

/** The `data` of a `toolUse` block, or null if it isn't one (or lacks an id). */
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
    /** Unvalidated: parsed straight from the file, so narrow with contentBlocks(). */
    content?: unknown;
    meta?: { timestamp?: number };
    /** Present on `Compaction` entries: the conversation summary. */
    summary?: string;
  };
}

/** The well-formed {kind, data} blocks of an entry, skipping anything malformed. */
function contentBlocks(content: unknown): KiroContentBlock[] {
  return Array.isArray(content) ? content.filter(isContentBlock) : [];
}

// Extract plain text from a text/thinking content block.
function blockText(c: KiroContentBlock): string {
  if (typeof c.data === 'string') return c.data;
  if (isRecord(c.data) && typeof c.data.text === 'string') return c.data.text;
  return '';
}

/**
 * The blocks of a persisted tool result worth sending: everything except inline images.
 *
 * kiro stores tool-result images as a raw byte array, costing several bytes of JSON per
 * image byte - one transcript page measured 5.1 MB against ~100 KB without them. Nothing
 * renders them anyway; images the user should see come from the file endpoints by path.
 */
function renderableBlocks(content: unknown): KiroContentBlock[] {
  return contentBlocks(content).filter((b) => b.kind !== 'image');
}

/** What kiro's own session file knows. A chat's identity and overrides live in casper.db. */
export interface PersistedSession {
  sessionId: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  agentId?: string;
  modelId?: string;
  contextUsagePercentage?: number;
}

function summarize(j: KiroSessionJson): PersistedSession {
  const state = j.session_state;
  const turns = state?.conversation_metadata?.user_turn_metadatas ?? [];
  const contextUsagePercentage =
    state?.rts_model_state?.context_usage_percentage ??
    turns[turns.length - 1]?.context_usage_percentage;

  return {
    sessionId: j.session_id,
    // Left empty when kiro has not named it; resolveSessionTitle decides what to show.
    title: j.title?.trim() ?? '',
    cwd: j.cwd,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    agentId: state?.agent_name,
    modelId: state?.rts_model_state?.model_info?.model_id,
    contextUsagePercentage,
  };
}

/** List all persisted sessions (as DORMANT summaries), newest first. */

// Delete a session's on-disk files: kiro's <id>.{json,jsonl,history,lock} and its
// per-session <id>/ directory (tasks, etc.). Missing paths are ignored. The .lock is kiro's
// "active in another process" marker, which 2.19 writes.
export async function deletePersistedSession(sessionId: string): Promise<void> {
  if (!isValidSessionId(sessionId)) return;
  const targets = [
    path.join(config.kiroSessionsDir, `${sessionId}.json`),
    path.join(config.kiroSessionsDir, `${sessionId}.jsonl`),
    path.join(config.kiroSessionsDir, `${sessionId}.history`),
    path.join(config.kiroSessionsDir, `${sessionId}.lock`),
    path.join(config.kiroSessionsDir, sessionId),
  ];
  await Promise.all(targets.map((f) => fs.rm(f, { recursive: true, force: true })));
}

/** Read one session's metadata summary, or null if it doesn't exist. */
export async function readPersistedSession(
  sessionId: string,
): Promise<PersistedSession | null> {
  if (!isValidSessionId(sessionId)) return null;
  try {
    const raw = await fs.readFile(
      path.join(config.kiroSessionsDir, `${sessionId}.json`),
      'utf8',
    );
    return summarize(JSON.parse(raw) as KiroSessionJson);
  } catch {
    return null;
  }
}

/**
 * How many prompts kiro has recorded for this session, which is the ordinal the next one
 * will take. Counted here rather than by the caller so the number that attachments are
 * written under is produced by the same rule that hydrateTranscript reads them back by:
 * one per Prompt entry, whether or not that entry ends up rendered.
 */
export async function promptCount(sessionId: string): Promise<number> {
  const entries = await readJsonlEntries(sessionId);
  return entries.filter((e) => e.kind === 'Prompt').length;
}

/**
 * A session's jsonl as parsed entries, skipping blank and malformed lines.
 *
 * Both the attachment ordinal writer (promptCount) and its reader (hydrateTranscript) count
 * Prompt entries from this one list, because an ordinal only identifies the same message if
 * the two agree on what a line is.
 */
async function readJsonlEntries(sessionId: string): Promise<KiroJsonlEntry[]> {
  if (!isValidSessionId(sessionId)) return [];
  let raw: string;
  try {
    raw = await fs.readFile(path.join(config.kiroSessionsDir, `${sessionId}.jsonl`), 'utf8');
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

/**
 * Whether kiro has recorded any conversation for this session.
 *
 * Its event log is created empty at session/new and only gets entries as turns
 * complete, and a session with none cannot be loaded into a fresh process - kiro
 * answers "Session not found" and deletes both files when the process that made it
 * exits. So this is what says whether a session can be rebuilt. Verified against
 * kiro 2.11: 0 bytes before the first turn, non-empty after it.
 */
export async function hasRecordedTurns(sessionId: string): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const st = await fs.stat(path.join(config.kiroSessionsDir, `${sessionId}.jsonl`));
    return st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Hydrate the conversation transcript from kiro's <id>.jsonl event log, matching
 * the shape the live stream produces: user/thinking/assistant messages plus
 * reconstructed tool calls. Tool uses live in AssistantMessage content
 * (`toolUse`) and their results arrive in later `ToolResults` entries
 * (`toolResult`), matched back by toolUseId.
 */
export async function hydrateTranscript(
  sessionId: string,
  /** Recorded attachments, keyed by the ordinal of the user message they belong to. */
  attachments?: Map<number, MessageAttachment[]>,
): Promise<TranscriptItem[]> {
  const items: TranscriptItem[] = [];
  // Counts Prompt entries as they are rebuilt, so it lines up with what runPrompt recorded.
  let userOrdinal = 0;
  // Tool-call items awaiting their result, keyed by toolUseId.
  const toolsById = new Map<string, TranscriptToolCall>();

  for (const entry of await readJsonlEntries(sessionId)) {
    const content = contentBlocks(entry.data.content);
    const textOf = (kind: string) =>
      content.filter((c) => c.kind === kind).map(blockText).join('');
    const baseId = entry.data.message_id ?? `${items.length}`;
    const ts = entry.data.meta?.timestamp;
    const pushMsg = (msg: TranscriptMessage) => items.push({ type: 'message', message: msg });

    if (entry.kind === 'Prompt') {
      // Attachments come from Casper's record, keyed by this message's position.
      const text = stripAttachmentsLine(textOf('text'));
      const attached = attachments?.get(userOrdinal);
      userOrdinal++;
      if (text.trim() || attached?.length)
        pushMsg({ id: `u-${baseId}`, role: 'user', text, timestamp: ts, attachments: attached });
    } else if (entry.kind === 'AssistantMessage') {
      // Order within an assistant turn: reasoning, spoken text, then tool uses.
      const thinking = textOf('thinking');
      if (thinking.trim())
        pushMsg({ id: `t-${baseId}`, role: 'thinking', text: thinking.trim(), timestamp: ts });
      const text = textOf('text');
      if (text.trim())
        pushMsg({ id: `a-${baseId}`, role: 'assistant', text, timestamp: ts });

      for (const c of content) {
        const d = toolUseData(c);
        if (!d) continue;
        // Completed by default; a later ToolResults entry may override the status.
        const tool: TranscriptToolCall = {
          id: d.toolUseId,
          name: d.name,
          title: d.name ?? d.toolUseId,
          status: 'completed',
          input: d.input,
          content: [],
        };
        toolsById.set(d.toolUseId, tool);
        items.push({ type: 'tool_call', tool });
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
      // kiro appends a Compaction entry (it does not rewrite prior entries) whose
      // summary becomes the working context. Surface it as a durable divider.
      const summary = entry.data.summary ?? '';
      if (summary.trim())
        items.push({ type: 'compaction', id: `c-${baseId}`, summary, timestamp: ts });
    }
  }
  return items;
}
