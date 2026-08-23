import fs from 'node:fs/promises';
import path from 'node:path';
import { ATTACHMENTS_PREFIX, type MessageAttachment } from '@casper/shared';
import { config } from '../config.js';
import { classifyKind } from '../util/filekind.js';
import type { Logger } from '../util/logger.js';
import type { SessionStore } from './sessionStore.js';

const MARKER = 'attachments_backfilled';

/**
 * Recover attachments sent before Casper recorded them.
 *
 * Those messages only ever left one trace: the "Attached files:" line in the prompt text.
 * Display no longer parses that line - it reads the recorded rows - so without this, every
 * attachment sent before the table existed is invisible, and old images lose their
 * thumbnails. Reading the legacy format once, to convert it, is the one job that parsing is
 * the right tool for.
 *
 * Runs once, guarded by a marker row. Existing rows are never overwritten: a session that
 * already has any is skipped, so a re-run can't disturb what the live path recorded.
 */
export async function backfillAttachments(store: SessionStore, log: Logger): Promise<void> {
  if (store.getMeta(MARKER)) return;

  let files: string[];
  try {
    files = await fs.readdir(config.kiroSessionsDir);
  } catch {
    // No session directory yet: nothing to convert, and nothing to come back for.
    store.setMeta(MARKER, new Date().toISOString());
    return;
  }

  let sessions = 0;
  let recovered = 0;
  for (const file of files.filter((f) => f.endsWith('.jsonl'))) {
    const sessionId = file.slice(0, -'.jsonl'.length);
    if (store.attachmentsBySession(sessionId).size > 0) continue;

    let raw: string;
    try {
      raw = await fs.readFile(path.join(config.kiroSessionsDir, file), 'utf8');
    } catch {
      continue;
    }

    let ordinal = 0;
    let found = false;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: { kind?: string; data?: { content?: unknown } };
      try {
        entry = JSON.parse(trimmed) as typeof entry;
      } catch {
        continue;
      }
      // Ordinals must be counted exactly as hydrateTranscript counts them: one per Prompt
      // entry, whether or not it carried anything.
      if (entry.kind !== 'Prompt') continue;
      const paths = pathsIn(entry.data?.content);
      if (paths.length > 0) {
        const attachments = await describe(paths);
        if (attachments.length > 0) {
          store.setAttachments(sessionId, ordinal, attachments);
          recovered += attachments.length;
          found = true;
        }
      }
      ordinal++;
    }
    if (found) sessions++;
  }

  store.setMeta(MARKER, new Date().toISOString());
  if (recovered > 0) {
    log.info({ sessions, recovered }, 'recovered attachments from older messages');
  }
}

/** The paths named by an attachments line in a prompt's text blocks, if it has one. */
function pathsIn(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const text = content
    .map((block) => {
      const b = block as { kind?: string; data?: { text?: unknown } };
      return b.kind === 'text' && typeof b.data?.text === 'string' ? b.data.text : '';
    })
    .join('');

  const line = text.split('\n').find((l) => l.startsWith(ATTACHMENTS_PREFIX));
  if (!line) return [];
  return line
    .slice(ATTACHMENTS_PREFIX.length)
    .split(', ')
    .map((s) => s.trim())
    // Absolute only. A relative path came from a build that stored them under the workspace,
    // and there is no reliable way to resolve it now.
    .filter((s) => s.startsWith('/'));
}

/** Size and kind for each path that still exists. A deleted upload is simply dropped. */
async function describe(paths: string[]): Promise<MessageAttachment[]> {
  const out: MessageAttachment[] = [];
  for (const p of paths) {
    try {
      const stat = await fs.stat(p);
      if (!stat.isFile()) continue;
      out.push({
        path: p,
        name: path.basename(p),
        size: stat.size,
        kind: classifyKind(p),
      });
    } catch {
      /* gone from disk: nothing to preview, so nothing to record */
    }
  }
  return out;
}
