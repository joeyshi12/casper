import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionSummary, TranscriptMessage } from '@casper/shared';
import { config } from '../config.js';
import type { Logger } from '../util/logger.js';

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

interface KiroJsonlEntry {
  kind: string;
  data: {
    message_id?: string;
    content?: Array<{ kind: string; data: string }>;
    meta?: { timestamp?: number };
  };
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

/** Read one session's metadata summary, or null if it doesn't exist. */
export async function readPersistedSession(
  sessionId: string,
): Promise<SessionSummary | null> {
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

/** Hydrate the conversation transcript from kiro's <id>.jsonl event log. */
export async function hydrateTranscript(sessionId: string): Promise<TranscriptMessage[]> {
  let raw: string;
  try {
    raw = await fs.readFile(
      path.join(config.kiroSessionsDir, `${sessionId}.jsonl`),
      'utf8',
    );
  } catch {
    return [];
  }
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: KiroJsonlEntry;
    try {
      entry = JSON.parse(trimmed) as KiroJsonlEntry;
    } catch {
      continue;
    }
    const role =
      entry.kind === 'Prompt'
        ? 'user'
        : entry.kind === 'AssistantMessage'
          ? 'assistant'
          : null;
    if (!role) continue;
    const text = (entry.data.content ?? [])
      .filter((c) => c.kind === 'text')
      .map((c) => c.data)
      .join('');
    messages.push({
      id: entry.data.message_id ?? `${role}-${messages.length}`,
      role,
      text,
      timestamp: entry.data.meta?.timestamp,
    });
  }
  return messages;
}
