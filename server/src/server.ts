import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './util/logger.js';
import { isWithinRoot } from './util/paths.js';

/** Starts the HTTP/WebSocket server and blocks until a signal stops it. */
export async function serve(): Promise<void> {
  // Fail fast on a misconfigured defaultCwd outside the file-access boundary,
  // or the directory picker and session creation silently break for every request.
  if (!isWithinRoot(config.fileRoot, config.defaultCwd)) {
    logger.warn(
      { fileRoot: config.fileRoot, defaultCwd: config.defaultCwd },
      'defaultCwd is outside fileRoot; new sessions and the directory ' +
        'picker will be rejected. Set fileRoot to an ancestor of defaultCwd.',
    );
  }

  const { app, manager } = await buildApp();

  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { host: config.host, port: config.port, auth: config.token ? 'on' : 'OFF' },
    'Casper server listening',
  );
  if (!config.token) {
    logger.warn('The token is empty - auth is DISABLED. Set it before exposing on a network.');
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down; draining live sessions');
    manager.disposeAll();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
