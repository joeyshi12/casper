import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino/file',
          options: { destination: 2 }, // stderr, so stdout stays clean
        },
});

export type Logger = typeof logger;
