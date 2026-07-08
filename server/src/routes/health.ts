import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@casper/shared';
import type { SessionManager } from '../session/SessionManager.js';
import { kiroVersion } from '../session/models.js';

export function registerHealthRoute(
  app: FastifyInstance,
  manager: SessionManager,
  startedAt: number,
): void {
  app.get('/api/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      kiroVersion: await kiroVersion(),
      liveSessions: manager.liveCount,
      uptimeMs: Date.now() - startedAt,
    };
  });
}
