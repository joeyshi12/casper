import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './util/logger.js';
import { isWithinRoot } from './util/paths.js';
import { backfillAttachments } from './session/backfillAttachments.js';
import { SessionStore } from './session/sessionStore.js';

/** Start the HTTP/WebSocket server and block until a signal stops it. */
export async function serve(): Promise<void> {
  // Fail fast on a misconfiguration where the default working directory sits
  // outside the file-access boundary - otherwise the directory picker and
  // session creation silently break (403 / throw) for every request.
  if (!isWithinRoot(config.fileRoot, config.defaultCwd)) {
    logger.warn(
      { fileRoot: config.fileRoot, defaultCwd: config.defaultCwd },
      'DEFAULT_CWD is outside CASPER_FILE_ROOT; new sessions and the directory ' +
        'picker will be rejected. Set CASPER_FILE_ROOT to an ancestor of DEFAULT_CWD.',
    );
  }

  // Messages sent before attachments were recorded left only the "Attached files:" line;
  // convert them once so their files are still visible. Here rather than in SessionManager's
  // constructor: constructing one must not touch the data directory, or a test that builds a
  // manager writes into the developer's real ~/.casper.
  await backfillAttachments(new SessionStore(), logger).catch((err) => {
    logger.warn({ err }, 'attachment backfill failed; older attachments stay hidden');
  });

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
