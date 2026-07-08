import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/** Extract a bearer token from the Authorization header or ?token= query. */
export function extractToken(req: {
  headers: Record<string, unknown>;
  query?: unknown;
}): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  const q = req.query as { token?: string } | undefined;
  if (q?.token) return q.token;
  return undefined;
}

export function tokenIsValid(token: string | undefined): boolean {
  // Empty configured token disables auth (local dev only).
  if (!config.token) return true;
  return token === config.token;
}

/** Fastify preHandler that rejects unauthenticated REST requests. */
export function registerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Health check and static assets are public; API routes are guarded.
    if (!req.url.startsWith('/api/')) return;
    if (req.url === '/api/health') return;
    if (!tokenIsValid(extractToken(req))) {
      reply.code(401).send({ error: 'Unauthorized: missing or invalid token' });
    }
  });
}
