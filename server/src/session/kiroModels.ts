import type { SessionConfigOption } from '@casper/shared';
import { db } from './db.js';

export interface KiroModel {
  name?: string;
  /** Effort levels, lowest first. Empty for a model without them. */
  levels: string[];
  recommended?: string;
  /** The section of kiro's `chat.modelDefaults` entry the effort sits under, such as
   *  `output_config`. */
  effortKey?: string;
}

// The last list written, so a session that reports the same models writes nothing.
let lastWritten = '';

/**
 * Keeps what a kiro session reported about each model: its display name and effort levels.
 * kiro sends these only on a session's model option, and `kiro-cli chat --list-models` has
 * neither, so they are stored for the model picker to use before any session has started.
 */
export function rememberKiroModels(options: SessionConfigOption[] | undefined): void {
  const choices = options?.find((o) => o.id === 'model')?.options;
  if (!choices?.length) return;
  const rows: [string, string | null, string, string | null, string | null][] = [];
  for (const c of choices) {
    if (typeof c.value !== 'string' || !c.value) continue;
    const kiro = c._meta?.kiro;
    const levels = Array.isArray(kiro?.effortLevels)
      ? kiro.effortLevels.filter((l): l is string => typeof l === 'string')
      : [];
    const recommended = typeof kiro?.defaultEffortLevel === 'string' ? kiro.defaultEffortLevel : null;
    const effortKey = typeof kiro?.effortSchemaPath === 'string' && kiro.effortSchemaPath ? kiro.effortSchemaPath : null;
    rows.push([c.value, typeof c.name === 'string' && c.name ? c.name : null, JSON.stringify(levels), recommended, effortKey]);
  }
  const key = JSON.stringify(rows);
  if (key === lastWritten) return;
  const d = db();
  d.exec('BEGIN');
  try {
    // Replaced whole, so a model kiro stopped offering, or one that lost its levels, goes.
    d.prepare('DELETE FROM kiro_models').run();
    const insert = d.prepare(
      'INSERT INTO kiro_models (model_id, name, levels, recommended, effort_key) VALUES (?, ?, ?, ?, ?)',
    );
    for (const r of rows) insert.run(...r);
    d.exec('COMMIT');
    lastWritten = key;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** The stored models, by model id. */
export function kiroModels(): Map<string, KiroModel> {
  const rows = db().prepare('SELECT model_id, name, levels, recommended, effort_key FROM kiro_models').all() as {
    model_id: string;
    name: string | null;
    levels: string;
    recommended: string | null;
    effort_key: string | null;
  }[];
  const out = new Map<string, KiroModel>();
  for (const r of rows) {
    try {
      const levels = JSON.parse(r.levels) as string[];
      out.set(r.model_id, {
        ...(r.name ? { name: r.name } : {}),
        levels,
        ...(r.recommended ? { recommended: r.recommended } : {}),
        ...(r.effort_key ? { effortKey: r.effort_key } : {}),
      });
    } catch {
      /* an unreadable row is skipped */
    }
  }
  return out;
}
