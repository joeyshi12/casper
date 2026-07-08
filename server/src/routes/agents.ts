import type { FastifyInstance } from 'fastify';
import type { AgentMode } from '@casper/shared';
import { listAgents } from '../session/agents.js';

export function registerAgentRoutes(app: FastifyInstance): void {
  app.get('/api/agents', async (): Promise<{ agents: AgentMode[] }> => {
    return { agents: await listAgents() };
  });
}
