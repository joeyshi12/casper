import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { logger } from './util/logger.js';
import { SessionManager } from './session/SessionManager.js';
import { registerAuth } from './routes/auth.js';
import { registerModelRoutes } from './routes/models.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerChatRoutes } from './routes/chats.js';
import { registerSubagentRoutes } from './routes/subagents.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerHealthRoute } from './routes/health.js';
import { registerWsGateway } from './ws/gateway.js';

interface CasperApp {
  app: FastifyInstance;
  manager: SessionManager;
}

export async function buildApp(): Promise<CasperApp> {
  const isProd = process.env.NODE_ENV === 'production';
  const app = Fastify({
    // Honors X-Forwarded-Proto so secure: 'auto' cookies detect HTTPS behind a
    // TLS-terminating tunnel or reverse proxy.
    trustProxy: true,
    // Skip the two-lines-per-request access log in production; logger.info/warn/error
    // calls still fire. Dev keeps it for debugging.
    disableRequestLogging: isProd,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: isProd
        ? undefined
        : { target: 'pino/file', options: { destination: 2 } },
    },
  });
  const manager = new SessionManager(logger);
  const startedAt = Date.now();

  await app.register(websocket, {
    options: { maxPayload: 16 * 1024 * 1024 },
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 20 },
  });

  await registerAuth(app);
  registerHealthRoute(app, manager, startedAt);
  registerModelRoutes(app);
  registerAgentRoutes(app);
  registerFsRoutes(app);
  registerChatRoutes(app, manager);
  registerSubagentRoutes(app, manager);
  registerWorkspaceRoutes(app, manager);
  registerUploadRoutes(app);
  registerWsGateway(app, manager);

  // Serve the built web app in production (single origin, no CORS needed).
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
    });
    // The manifest and icons are requested by name, not by content hash, so a stale
    // copy in a browser or proxy would mask an icon change.
    app.addHook('onSend', async (req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      if (path === '/manifest.json' || path.startsWith('/icons/')) {
        reply.header('cache-control', 'public, max-age=300');
      }
    });
    // SPA fallback: serve index.html for client-side routes only. API/WS and anything
    // that looks like a static asset must 404 rather than fall back to index.html, or
    // a request for a since-rebuilt asset returns HTML with the wrong MIME type.
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
