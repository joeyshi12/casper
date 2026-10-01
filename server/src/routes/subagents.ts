import type { FastifyInstance } from 'fastify';
import type { SubagentDetailResponse, SubagentListResponse } from '@casper/shared';
import type { SessionManager } from '../session/SessionManager.js';

// Subagents (child kiro sessions spawned by a chat's `subagent` tool calls). Reachable
// only under the chat they belong to - getSubagentDetail checks the child's own
// parent_session_id against the chat's session, so one chat's id can't be used to read
// another chat's subagent transcript.
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
