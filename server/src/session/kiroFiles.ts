import fs from 'node:fs/promises';
import path from 'node:path';
import type { MessageAttachment, StoredTurnEnding, TranscriptItem } from '@casper/shared';
import { stripAttachmentsLine } from '@casper/shared';
import { isValidSessionId } from '../util/paths.js';
import {
  readSubExecutions,
  readV3Entries,
  readV3Session,
  subExecutionFile,
  v3SessionDir,
  v3SessionDirs,
  type SubExecution,
} from './kiroV3Files.js';

// Reads kiro-cli's own session files so Casper can list and hydrate dormant sessions
// without spawning a process. The file layout is in kiroV3Files.ts.

export type { SubExecution } from './kiroV3Files.js';

/** kiro's own session file. A chat's identity and overrides live in casper.db. */
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

/** A transcript before stored turn endings and attachments are merged in. A prompt is
 *  kept apart from the items so the merge can find each turn. */
export type TranscriptEntry =
  | { kind: 'prompt'; id: string; text: string; atMs?: number; timestamp?: number }
  | { kind: 'item'; item: TranscriptItem };

/** One session's metadata, or null if kiro has no such session. */
export async function readPersistedSession(sessionId: string): Promise<PersistedSession | null> {
  const dir = await v3SessionDir(sessionId);
  return dir ? readV3Session(dir) : null;
}

/** Many sessions' metadata at once, keyed by id, scanning the store only once. */
export async function readPersistedSessions(sessionIds: string[]): Promise<Map<string, PersistedSession>> {
  const dirs = await v3SessionDirs();
  const out = new Map<string, PersistedSession>();
  await Promise.all(
    sessionIds.filter(isValidSessionId).map(async (id) => {
      const dir = dirs.get(id);
      const found = dir ? await readV3Session(dir) : null;
      if (found) out.set(id, found);
    }),
  );
  return out;
}

export async function deletePersistedSession(sessionId: string): Promise<void> {
  const dir = await v3SessionDir(sessionId);
  if (dir) await fs.rm(dir, { recursive: true, force: true });
}

/** Whether kiro can load this session back. Loading an id kiro has not stored starts an
 *  empty session under that id instead. */
export async function isLoadable(sessionId: string): Promise<boolean> {
  return (await v3SessionDir(sessionId)) !== undefined;
}

async function readEntries(sessionId: string): Promise<TranscriptEntry[]> {
  const dir = await v3SessionDir(sessionId);
  return dir ? readV3Entries(path.join(dir, 'messages.jsonl')) : [];
}

/** The ordinal the next prompt takes, counted the same way hydrateTranscript does. */
export async function promptCount(sessionId: string): Promise<number> {
  return (await readEntries(sessionId)).filter((e) => e.kind === 'prompt').length;
}

/* A prompt belongs to a stored turn if it was written between the turn's start and end,
   give or take this much: kiro stamped prompts in whole seconds before V3. */
const STAMP_PAD_MS = 2000;

function endingItems(e: StoredTurnEnding): TranscriptItem[] {
  const prefix = `te${e.id}-`;
  const items = e.items.map((it): TranscriptItem =>
    it.type === 'message' ? { type: 'message', message: { ...it.message, id: prefix + it.message.id } } : it,
  );
  items.push(
    e.kind === 'failed'
      ? { type: 'turn_error', id: `${prefix}end`, message: e.message ?? '', timestamp: e.endedAt }
      : { type: 'turn_interrupted', id: `${prefix}end`, timestamp: e.endedAt },
  );
  return items;
}

/** Merges stored turn endings and attachments into a session's entries. A stored ending
 *  replaces the entries kiro wrote for its turn, found by prompt text and time. One whose
 *  prompt kiro never wrote is placed by time among the prompts. */
function mergeTranscript(
  entries: TranscriptEntry[],
  attachments: Map<number, MessageAttachment[]> | undefined,
  endings: StoredTurnEnding[],
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let userOrdinal = 0;
  const waiting = [...endings];
  let replaced = false;

  const unrecorded = (e: StoredTurnEnding): TranscriptItem[] => [
    { type: 'message', message: { id: `te${e.id}-u`, role: 'user', text: e.prompt, timestamp: e.startedAt } },
    ...endingItems(e),
  ];

  for (const entry of entries) {
    if (entry.kind === 'item') {
      // A compaction is the conversation's, not the turn's, so it outlives a replacement.
      if (!replaced || entry.item.type === 'compaction') items.push(entry.item);
      continue;
    }
    replaced = false;
    const text = stripAttachmentsLine(entry.text);
    let matched: StoredTurnEnding | undefined;
    const at = entry.atMs;
    if (at !== undefined) {
      matched = waiting.find(
        (e) =>
          e.prompt.trim() === text.trim() &&
          at >= e.startedAt - STAMP_PAD_MS &&
          at <= e.endedAt + STAMP_PAD_MS,
      );
      while (waiting.length && waiting[0] !== matched && waiting[0]!.endedAt < at - STAMP_PAD_MS) {
        items.push(...unrecorded(waiting.shift()!));
      }
      if (matched) waiting.splice(waiting.indexOf(matched), 1);
    }
    const attached = attachments?.get(userOrdinal);
    userOrdinal++;
    if (text.trim() || attached?.length) {
      items.push({ type: 'message', message: { id: `u-${entry.id}`, role: 'user', text, timestamp: entry.timestamp, attachments: attached } });
    }
    if (matched) {
      items.push(...endingItems(matched));
      replaced = true;
    }
  }
  for (const e of waiting) items.push(...unrecorded(e));
  return items;
}

/** Hydrates a session's transcript from kiro's files, matching the live stream's shape. */
export async function hydrateTranscript(
  sessionId: string,
  attachments?: Map<number, MessageAttachment[]>,
  endings: StoredTurnEnding[] = [],
): Promise<TranscriptItem[]> {
  return mergeTranscript(await readEntries(sessionId), attachments, endings);
}

/** The subagents a session started, or null when kiro has no such session. */
export async function listSubExecutions(sessionId: string): Promise<SubExecution[] | null> {
  const dir = await v3SessionDir(sessionId);
  return dir ? readSubExecutions(dir) : null;
}

/** One subagent's transcript, or null if the session has no such subagent. Read from
 *  under the parent's own directory, so a chat can only reach its own subagents. */
export async function hydrateSubExecution(sessionId: string, subagentId: string): Promise<TranscriptItem[] | null> {
  const dir = await v3SessionDir(sessionId);
  const file = dir ? subExecutionFile(dir, subagentId) : undefined;
  if (!file) return null;
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  return mergeTranscript(await readV3Entries(file), undefined, []);
}
