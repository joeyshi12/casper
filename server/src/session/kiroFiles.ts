import fs from 'node:fs/promises';
import path from 'node:path';
import type { MessageAttachment, StoredTurnEnding, TranscriptItem } from '@casper/shared';
import { stripAttachmentsLine } from '@casper/shared';
import { isValidSessionId } from '../util/paths.js';
import {
  deleteV2Session,
  readV2Entries,
  readV2Session,
  v2HasRecordedTurns,
} from './kiroV2Files.js';
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
// without spawning a process. kiro V3 keeps its own store (kiroV3Files.ts) and copies a
// V2 session into it the first time it loads one, so a session is read from the V3
// store when it is there and from the V2 files (kiroV2Files.ts) when it is not yet.

export { listChildSessions, readChildSession } from './kiroV2Files.js';
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

/** One child session of a V2 session, as recorded in its own file. */
export interface ChildSession extends PersistedSession {
  parentSessionId: string;
}

/** A transcript before stored turn endings and attachments are merged in. A prompt is
 *  kept apart from the items so the merge can find each turn. */
export type TranscriptEntry =
  | { kind: 'prompt'; id: string; text: string; atMs?: number; timestamp?: number }
  | { kind: 'item'; item: TranscriptItem };

/** One session's metadata, or null if neither store has it. The context usage needs a
 *  read of the conversation file in V3, so it is only read when asked for. */
export async function readPersistedSession(
  sessionId: string,
  opts: { contextUsage?: boolean } = {},
): Promise<PersistedSession | null> {
  if (!isValidSessionId(sessionId)) return null;
  const dir = await v3SessionDir(sessionId);
  return (dir ? await readV3Session(dir, opts) : null) ?? readV2Session(sessionId);
}

/** Many sessions' metadata at once, keyed by id, scanning the V3 store only once. */
export async function readPersistedSessions(sessionIds: string[]): Promise<Map<string, PersistedSession>> {
  const dirs = await v3SessionDirs();
  const out = new Map<string, PersistedSession>();
  await Promise.all(
    sessionIds.filter(isValidSessionId).map(async (id) => {
      const dir = dirs.get(id);
      const found = (dir ? await readV3Session(dir) : null) ?? (await readV2Session(id));
      if (found) out.set(id, found);
    }),
  );
  return out;
}

/** Deletes a session from both stores. */
export async function deletePersistedSession(sessionId: string): Promise<void> {
  if (!isValidSessionId(sessionId)) return;
  const dir = await v3SessionDir(sessionId);
  await Promise.all([dir ? fs.rm(dir, { recursive: true, force: true }) : undefined, deleteV2Session(sessionId)]);
}

/** Whether kiro can load this session back. kiro V3 loads any session it has stored,
 *  and copies in a V2 one that has a recorded turn. Loading an id it has neither of
 *  starts an empty session under that id instead. */
export async function isLoadable(sessionId: string): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  return (await v3SessionDir(sessionId)) !== undefined || v2HasRecordedTurns(sessionId);
}

async function readEntries(sessionId: string): Promise<TranscriptEntry[]> {
  if (!isValidSessionId(sessionId)) return [];
  const dir = await v3SessionDir(sessionId);
  return dir ? readV3Entries(path.join(dir, 'messages.jsonl')) : readV2Entries(sessionId);
}

/** The ordinal the next prompt takes, counted the same way hydrateTranscript does. */
export async function promptCount(sessionId: string): Promise<number> {
  return (await readEntries(sessionId)).filter((e) => e.kind === 'prompt').length;
}

/* A prompt belongs to a stored turn if it was written between the turn's start and end,
   give or take this much: kiro 2.x stamps a prompt in whole seconds. */
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

/** The subagents a V3 session started, or null when the session is not in the V3 store. */
export async function listSubExecutions(sessionId: string): Promise<SubExecution[] | null> {
  const dir = await v3SessionDir(sessionId);
  return dir ? readSubExecutions(dir) : null;
}

/** One V3 subagent's transcript, or null if the session has no such subagent. Read from
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
