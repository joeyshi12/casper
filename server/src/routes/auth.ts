import crypto from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { LoginStore } from '../session/logins.js';
import { AttemptLimiter } from '../util/rateLimit.js';

const SESSION_COOKIE = 'casper.sid';

// Built lazily: a LoginStore prunes on construction, so building it at module
// scope would open the database on import, before a test could repoint
// config.casperDataDir.
let loginStore: LoginStore | undefined;
function logins(): LoginStore {
  loginStore ??= new LoginStore();
  return loginStore;
}

// Ten wrong tokens per quarter hour. Keyed on the socket address, not
// X-Forwarded-For, which anyone behind a proxy could spoof for a fresh limit.
const loginLimiter = new AttemptLimiter(10, 15 * 60 * 1000);

/** Compares secrets without leaking match length through timing. */
function secretMatches(supplied: string | undefined, expected: string): boolean {
  if (typeof supplied !== 'string') return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function extractToken(req: {
  headers: Record<string, unknown>;
  query?: unknown;
}): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  const q = req.query as { token?: string } | undefined;
  if (q?.token) return q.token;
  return undefined;
}

export function authDisabled(): boolean {
  return !config.token;
}

function sessionToken(req: FastifyRequest): string | undefined {
  return req.cookies?.[SESSION_COOKIE];
}

export function hasValidSession(req: FastifyRequest): boolean {
  return logins().verify(sessionToken(req)) !== null;
}

// secure: 'auto' sets Secure only over HTTPS. SameSite=Lax rides the WebSocket
// upgrade and top-level navigations to our own origin; Strict would drop it there.
function cookieOptions(): {
  path: string;
  httpOnly: true;
  sameSite: 'lax';
  secure: 'auto';
  maxAge: number;
} {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: config.sessionTtlSeconds,
  };
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCookie);

  app.post('/api/login', async (req, reply) => {
    if (!authDisabled()) {
      const limit = loginLimiter.check(req.ip);
      if (!limit.allowed) {
        return reply
          .code(429)
          .header('retry-after', String(limit.retryAfterSeconds))
          .send({ error: `Too many attempts; try again in ${limit.retryAfterSeconds}s` });
      }
      const body = (req.body ?? {}) as { token?: string };
      const supplied = body.token ?? extractToken(req);
      if (!secretMatches(supplied, config.token)) {
        loginLimiter.fail(req.ip);
        return reply.code(401).send({ error: 'Invalid token' });
      }
      loginLimiter.succeed(req.ip);
    }
    const ua = req.headers['user-agent'];
    const { token } = logins().create(typeof ua === 'string' ? ua : undefined);
    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    logins().revokeToken(sessionToken(req));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/devices', async (req) => {
    return { devices: logins().list(sessionToken(req)) };
  });

  app.delete('/api/devices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = logins().list(sessionToken(req)).find((d) => d.current);
    const removed = logins().revokeId(id);
    if (current?.id === id) reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: removed };
  });

  app.post('/api/logout-all', async (_req, reply) => {
    logins().revokeAll();
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.url === '/api/health' || req.url === '/api/login') return;
    if (authDisabled()) return;
    if (hasValidSession(req)) return;
    reply.code(401).send({ error: 'Unauthorized: log in first' });
  });
}
