import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './util/logger.js';

async function main() {
  const { app, manager } = await buildApp();

  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { host: config.host, port: config.port, auth: config.token ? 'on' : 'OFF' },
    'Casper server listening',
  );
  if (!config.token) {
    logger.warn('CASPER_TOKEN is empty - auth is DISABLED. Set it before exposing on a network.');
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

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
