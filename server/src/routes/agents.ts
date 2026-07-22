import type { FastifyInstance } from 'fastify';
import type { AgentsResponse } from '@casper/shared';
import { listAgents } from '../session/agents.js';
import { config } from '../config.js';

export function registerAgentRoutes(app: FastifyInstance): void {
  app.get('/api/agents', async (): Promise<AgentsResponse> => {
    return { agents: await listAgents(), defaultAgentId: config.defaultAgent };
  });
}
