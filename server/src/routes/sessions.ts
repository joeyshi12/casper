import type { FastifyInstance } from 'fastify';
import type {
  CreateSessionRequest,
  PromptRequest,
  RenameSessionRequest,
  SetModeRequest,
  SetModelRequest,
} from '@casper/shared';
import type { SessionManager } from '../session/SessionManager.js';

export function registerSessionRoutes(
  app: FastifyInstance,
  manager: SessionManager,
): void {
  // List LIVE + DORMANT sessions.
  app.get('/api/sessions', async () => {
    return { sessions: await manager.listSessions() };
  });

  // Create a new session.
  app.post('/api/sessions', async (req, reply) => {
    const body = (req.body ?? {}) as CreateSessionRequest;
    try {
      return await manager.createSession({
        cwd: body.cwd,
        agentId: body.agentId,
        modelId: body.modelId,
      });
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // Get session detail (hydrated transcript + observability + replay head).
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    try {
      return await manager.getDetail(req.params.id);
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });

  // Fire-and-forget prompt over REST (also available over WS). runPrompt spawns
  // the kiro process lazily if the session isn't live yet.
  app.post<{ Params: { id: string }; Body: PromptRequest }>(
    '/api/sessions/:id/prompt',
    async (req, reply) => {
      try {
        await manager.runPrompt(req.params.id, req.body.prompt);
        return { ok: true };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/sessions/:id/cancel', async (req) => {
    manager.cancel(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: SetModelRequest }>(
    '/api/sessions/:id/model',
    async (req) => {
      await manager.setModel(req.params.id, req.body.modelId);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: SetModeRequest }>(
    '/api/sessions/:id/mode',
    async (req) => {
      await manager.setMode(req.params.id, req.body.modeId);
      return { ok: true };
    },
  );

  // Rename a session (Casper-side title override).
  app.post<{ Params: { id: string }; Body: RenameSessionRequest }>(
    '/api/sessions/:id/rename',
    async (req) => {
      manager.renameSession(req.params.id, req.body.title);
      return { ok: true };
    },
  );

  // Permanently delete a session (memory + on-disk files).
  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    await manager.deleteSession(req.params.id);
    return { ok: true };
  });
}
