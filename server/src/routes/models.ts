import type { FastifyInstance } from 'fastify';
import type { ModelsResponse } from '@casper/shared';
import { listModels } from '../session/models.js';

export function registerModelRoutes(app: FastifyInstance): void {
  app.get('/api/models', async (): Promise<ModelsResponse> => {
    const models = await listModels(app.log);
    return { models };
  });
}
