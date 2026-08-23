import type { FastifyInstance } from 'fastify';
import type {
  CreateChatRequest,
  PromptRequest,
  RenameChatRequest,
  SetCwdRequest,
  SetModeRequest,
  SetModelRequest,
} from '@casper/shared';
import type { SessionManager } from '../session/SessionManager.js';

export function registerChatRoutes(
  app: FastifyInstance,
  manager: SessionManager,
): void {
  app.get('/api/chats', async () => {
    return { chats: await manager.listChats() };
  });

  app.post('/api/chats', async (req, reply) => {
    const body = (req.body ?? {}) as CreateChatRequest;
    try {
      return await manager.createChat({
        cwd: body.cwd,
        agentId: body.agentId,
        modelId: body.modelId,
        freshWorkspace: body.freshWorkspace,
        title: body.title,
        // Not optional in practice: the client's chat already owns any file uploaded before
        // the session existed, so dropping it here strands those files under an id nothing
        // refers to again.
        chatId: body.chatId,
      });
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // Get session detail (hydrated transcript + observability + replay head).
  app.get<{ Params: { id: string } }>('/api/chats/:id', async (req, reply) => {
    try {
      return await manager.getDetail(req.params.id);
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });

  // Older transcript items for lazy load-on-scroll-up: returns items in
  // [offset, offset+limit) of the full transcript.
  app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>(
    '/api/chats/:id/transcript',
    async (req, reply) => {
      const offset = Number.parseInt(req.query.offset ?? '', 10);
      const limit = Number.parseInt(req.query.limit ?? '', 10);
      if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(limit) || limit <= 0) {
        reply.code(400);
        return { error: 'offset (>=0) and limit (>0) are required' };
      }
      try {
        return { items: await manager.getTranscriptPage(req.params.id, offset, limit) };
      } catch (err) {
        reply.code(404);
        return { error: (err as Error).message };
      }
    },
  );

  // Fire-and-forget prompt over REST (also available over WS). runPrompt spawns
  // the kiro process lazily if the session isn't live yet.
  app.post<{ Params: { id: string }; Body: PromptRequest }>(
    '/api/chats/:id/prompt',
    async (req, reply) => {
      try {
        await manager.runPrompt(req.params.id, req.body.prompt, req.body.attachments);
        return { ok: true };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/chats/:id/cancel', async (req) => {
    manager.cancel(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: SetModelRequest }>(
    '/api/chats/:id/model',
    async (req) => {
      await manager.setModel(req.params.id, req.body.modelId);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: SetModeRequest }>(
    '/api/chats/:id/mode',
    async (req) => {
      await manager.setMode(req.params.id, req.body.modeId);
      return { ok: true };
    },
  );

  // Rename a session (Casper-side title override).
  app.post<{ Params: { id: string }; Body: RenameChatRequest }>(
    '/api/chats/:id/rename',
    async (req) => {
      manager.renameChat(req.params.id, req.body.title);
      return { ok: true };
    },
  );

  // Re-point a session at a different working directory (Casper-side override,
  // for when the original folder was moved or deleted).
  app.post<{ Params: { id: string }; Body: SetCwdRequest }>(
    '/api/chats/:id/cwd',
    async (req, reply) => {
      const cwd = (req.body?.cwd ?? '').trim();
      if (!cwd) {
        reply.code(400);
        return { error: 'cwd is required' };
      }
      try {
        return { ok: true, cwd: await manager.setChatCwd(req.params.id, cwd) };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    },
  );

  // Restart the session's kiro child so a `.kiro` directory, agent definition or
  // MCP server that changed since it started is picked up. Returns the refreshed
  // detail, so the client applies it exactly as it applies a resync.
  app.post<{ Params: { id: string } }>('/api/chats/:id/reload', async (req, reply) => {
    try {
      return await manager.reloadChat(req.params.id);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // Permanently delete a session (memory + on-disk files).
  app.delete<{ Params: { id: string } }>('/api/chats/:id', async (req) => {
    await manager.deleteChat(req.params.id);
    return { ok: true };
  });
}
