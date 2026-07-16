import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  SessionSummary,
  TranscriptItem,
  TranscriptMessage,
  TranscriptToolCall,
} from '@casper/shared';
import { imageAttachmentPaths, stripAttachmentsLine } from '@casper/shared';
import { config } from '../config.js';
import type { Logger } from '../util/logger.js';
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

// A content block's `data` is a string for `text`, but an object for structured
// kinds: `thinking` ({text, signature}), `toolUse` ({toolUseId, name, input}),
// and `toolResult` ({toolUseId, status, content}).
interface KiroToolUseData {
  toolUseId: string;
  name?: string;
  input?: unknown;
}
interface KiroToolResultData {
  toolUseId: string;
  status?: string;
  content?: unknown[];
}
type KiroContentBlock =
  | { kind: 'text'; data: string }
  | { kind: 'thinking'; data: { text?: string } }
  | { kind: 'toolUse'; data: KiroToolUseData }
  | { kind: 'toolResult'; data: KiroToolResultData }
  | { kind: string; data: unknown };

interface KiroJsonlEntry {
  kind: string;
  data: {
    message_id?: string;
    content?: KiroContentBlock[];
    meta?: { timestamp?: number };
    /** Present on `Compaction` entries: the conversation summary. */
    summary?: string;
  };
}

// Extract plain text from a text/thinking content block.
function blockText(c: KiroContentBlock): string {
  if (typeof c.data === 'string') return c.data;
  const d = c.data as { text?: string } | null;
  return d?.text ?? '';
}

function summarize(j: KiroSessionJson): SessionSummary {
  const state = j.session_state;
  const turns = state?.conversation_metadata?.user_turn_metadatas ?? [];
  const creditsSpent = turns.reduce(
    (sum, t) => sum + (t.metering_usage ?? []).reduce((a, m) => a + m.value, 0),
    0,
  );
  const contextUsagePercentage =
    state?.rts_model_state?.context_usage_percentage ??
    turns[turns.length - 1]?.context_usage_percentage;

  return {
    sessionId: j.session_id,
    title: j.title?.trim() || 'Untitled session',
    cwd: j.cwd,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    liveness: 'dormant',
    agentId: state?.agent_name,
    modelId: state?.rts_model_state?.model_info?.model_id,
    running: false,
    creditsSpent,
    contextUsagePercentage,
  };
}

/** List all persisted sessions (as DORMANT summaries), newest first. */
export async function listPersistedSessions(log: Logger): Promise<SessionSummary[]> {
  let files: string[];
  try {
    files = await fs.readdir(config.kiroSessionsDir);
  } catch {
    return [];
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  const summaries: SessionSummary[] = [];
  await Promise.all(
    jsonFiles.map(async (f) => {
      try {
        const raw = await fs.readFile(path.join(config.kiroSessionsDir, f), 'utf8');
        summaries.push(summarize(JSON.parse(raw) as KiroSessionJson));
      } catch (err) {
        log.debug({ err, f }, 'kiroFiles: skipping unreadable session file');
      }
    }),
  );
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}

// Delete a session's on-disk files: kiro's <id>.{json,jsonl,history}, kiro's
// per-session <id>/ directory (tasks, etc.), and Casper's event mirror.
// Missing paths are ignored.
export async function deletePersistedSession(sessionId: string): Promise<void> {
  if (!isValidSessionId(sessionId)) return;
  const targets = [
    path.join(config.kiroSessionsDir, `${sessionId}.json`),
    path.join(config.kiroSessionsDir, `${sessionId}.jsonl`),
    path.join(config.kiroSessionsDir, `${sessionId}.history`),
    path.join(config.kiroSessionsDir, sessionId),
    path.join(config.casperDataDir, `${sessionId}.events.jsonl`),
  ];
  await Promise.all(targets.map((f) => fs.rm(f, { recursive: true, force: true })));
}

/** Read one session's metadata summary, or null if it doesn't exist. */
export async function readPersistedSession(
  sessionId: string,
): Promise<SessionSummary | null> {
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
 * Hydrate the conversation transcript from kiro's <id>.jsonl event log, matching
 * the shape the live stream produces: user/thinking/assistant messages plus
 * reconstructed tool calls. Tool uses live in AssistantMessage content
 * (`toolUse`) and their results arrive in later `ToolResults` entries
 * (`toolResult`), matched back by toolUseId.
 */
export async function hydrateTranscript(sessionId: string): Promise<TranscriptItem[]> {
  if (!isValidSessionId(sessionId)) return [];
  let raw: string;
  try {
    raw = await fs.readFile(
      path.join(config.kiroSessionsDir, `${sessionId}.jsonl`),
      'utf8',
    );
  } catch {
    return [];
  }

  const items: TranscriptItem[] = [];
  // Tool-call items awaiting their result, keyed by toolUseId.
  const toolsById = new Map<string, TranscriptToolCall>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: KiroJsonlEntry;
    try {
      entry = JSON.parse(trimmed) as KiroJsonlEntry;
    } catch {
      continue;
    }
    const content = entry.data.content ?? [];
    const textOf = (kind: string) =>
      content.filter((c) => c.kind === kind).map(blockText).join('');
    const baseId = entry.data.message_id ?? `${items.length}`;
    const ts = entry.data.meta?.timestamp;
    const pushMsg = (msg: TranscriptMessage) => items.push({ type: 'message', message: msg });

    if (entry.kind === 'Prompt') {
      const raw = textOf('text');
      const text = stripAttachmentsLine(raw);
      const imagePaths = imageAttachmentPaths(raw);
      if (text.trim() || imagePaths.length)
        pushMsg({ id: `u-${baseId}`, role: 'user', text, timestamp: ts, imagePaths });
    } else if (entry.kind === 'AssistantMessage') {
      // Order within an assistant turn: reasoning, spoken text, then tool uses.
      const thinking = textOf('thinking');
      if (thinking.trim())
        pushMsg({ id: `t-${baseId}`, role: 'thinking', text: thinking, timestamp: ts });
      const text = textOf('text');
      if (text.trim())
        pushMsg({ id: `a-${baseId}`, role: 'assistant', text, timestamp: ts });

      for (const c of content) {
        if (c.kind !== 'toolUse') continue;
        const d = c.data as KiroToolUseData;
        // Completed by default; a later ToolResults entry may override the status.
        const tool: TranscriptToolCall = {
          id: d.toolUseId,
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
        if (c.kind !== 'toolResult') continue;
        const d = c.data as KiroToolResultData;
        const tool = toolsById.get(d.toolUseId);
        if (!tool) continue;
        tool.status = d.status === 'error' ? 'failed' : 'completed';
        tool.content = d.content ?? [];
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
