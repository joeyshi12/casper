import { db } from './db.js';

/**
 * Which parent tool call and stage name a kiro 2.x child session belongs to. kiro 2.x
 * did not record it, so an earlier Casper saved what it learned live, and title matching
 * (subagentFallbackMatch.ts) saves what it finds, so it runs once per child. kiro V3
 * records each subagent's call in the parent's own file instead.
 */
export class SubagentLinkStore {
  /** Record (or correct) one child's link. Idempotent: a repeat call with the same
   *  values is a no-op, and the row always reflects the latest call to resolve it. */
  record(childSessionId: string, parentSessionId: string, toolCallId: string, stageName: string): void {
    db()
      .prepare(
        `INSERT INTO subagent_links (child_session_id, parent_session_id, tool_call_id, stage_name)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(child_session_id) DO UPDATE SET
           parent_session_id = excluded.parent_session_id,
           tool_call_id = excluded.tool_call_id,
           stage_name = excluded.stage_name`,
      )
      .run(childSessionId, parentSessionId, toolCallId, stageName);
  }

  /** Every link recorded for one parent session's children, keyed by child session id. */
  forParent(parentSessionId: string): Map<string, { toolCallId: string; stageName: string }> {
    const rows = db()
      .prepare(
        'SELECT child_session_id, tool_call_id, stage_name FROM subagent_links WHERE parent_session_id = ?',
      )
      .all(parentSessionId) as { child_session_id: string; tool_call_id: string; stage_name: string }[];
    const out = new Map<string, { toolCallId: string; stageName: string }>();
    for (const r of rows) out.set(r.child_session_id, { toolCallId: r.tool_call_id, stageName: r.stage_name });
    return out;
  }
}
