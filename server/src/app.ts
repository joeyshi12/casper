import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { logger } from './util/logger.js';
import { SessionManager } from './session/SessionManager.js';
import { registerAuth } from './routes/auth.js';
import { registerModelRoutes } from './routes/models.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerHealthRoute } from './routes/health.js';
import { registerWsGateway } from './ws/gateway.js';

export interface CasperApp {
  app: FastifyInstance;
  manager: SessionManager;
}

export async function buildApp(): Promise<CasperApp> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino/file', options: { destination: 2 } },
    },
  });
  const manager = new SessionManager(logger);
  const startedAt = Date.now();

  await app.register(cors, { origin: true });
  await app.register(websocket, {
    options: { maxPayload: 16 * 1024 * 1024 },
  });

  registerAuth(app);
  registerHealthRoute(app, manager, startedAt);
  registerModelRoutes(app);
  registerAgentRoutes(app);
  registerSessionRoutes(app, manager);
  registerWsGateway(app, manager);

  // Serve the built web app in production (single origin, no CORS needed).
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
    });
    // SPA fallback: serve index.html for client-side routes only. API/WS and
    // anything that looks like a static asset (under /assets/ or with a file
    // extension) must 404 rather than fall back to index.html - otherwise a
    // request for a since-rebuilt asset returns HTML, and the browser reports
    // the wrong MIME type ("text/html" for a .css/.js).
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      const looksLikeAsset =
        path.startsWith('/assets/') || /\.[a-zA-Z0-9]+$/.test(path);
      if (
        path.startsWith('/api/') ||
        path.startsWith('/ws') ||
        looksLikeAsset
      ) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return { app, manager };
}
