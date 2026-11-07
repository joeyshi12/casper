import type { FastifyInstance } from 'fastify';
import type { SubagentDetailResponse, SubagentListResponse } from '@casper/shared';
import type { SessionManager } from '../session/SessionManager.js';

// The subagents a chat started. Reachable only under the chat they belong to: a kiro V3
// subagent is read from under the chat's own session directory, and a kiro 2.x child's
// parent_session_id is checked against the chat's session, so one chat's id can't be
// used to read another chat's subagent transcript.
export function registerSubagentRoutes(
  app: FastifyInstance,
  manager: SessionManager,
): void {
  app.get<{ Params: { id: string } }>(
    '/api/chats/:id/subagents',
    async (req, reply): Promise<SubagentListResponse | { error: string }> => {
      try {
        return { subagents: await manager.getSubagents(req.params.id) };
      } catch (err) {
        reply.code(404);
        return { error: (err as Error).message };
      }
    },
  );

  app.get<{ Params: { id: string; subagentId: string } }>(
    '/api/chats/:id/subagents/:subagentId',
    async (req, reply): Promise<SubagentDetailResponse | { error: string }> => {
      try {
        return await manager.getSubagentDetail(req.params.id, req.params.subagentId);
      } catch (err) {
        reply.code(404);
        return { error: (err as Error).message };
      }
    },
  );
}
