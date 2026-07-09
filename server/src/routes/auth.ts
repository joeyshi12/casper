import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { LoginStore } from '../session/logins.js';
import { logger } from '../util/logger.js';

const SESSION_COOKIE = 'casper.sid';

// One store for the process. Each login is a device; the cookie holds an opaque
// random token, the store keeps only its hash.
const logins = new LoginStore(logger);

/** Extract a bearer token from the Authorization header or ?token= query. */
export function extractToken(req: {
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

/** True when auth is disabled (no shared secret configured - local dev only). */
export function authDisabled(): boolean {
  return !config.token;
}

/** The raw session token from the request cookie, if present. */
export function sessionToken(req: FastifyRequest): string | undefined {
  return req.cookies?.[SESSION_COOKIE];
}

/** Does the request carry a valid, unexpired session cookie? */
export function hasValidSession(req: FastifyRequest): boolean {
  return logins.verify(sessionToken(req)) !== null;
}

// Cookie options. `secure: 'auto'` sets the Secure flag only over HTTPS (so it
// works on a plain-HTTP LAN and a tunneled HTTPS origin alike). SameSite=Lax
// still blocks cross-site POSTs (our CSRF concern) but, unlike Strict, lets the
// cookie ride the WebSocket upgrade and top-level navigations to our own origin
// - Strict drops it there, which breaks WS auth and causes a reconnect loop.
// maxAge matches the store TTL.
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

/** Register the cookie plugin, login/logout/device routes, and the guard. */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCookie);

  // Log in with the shared secret: mint a device login and set its opaque token
  // as an httpOnly cookie. The raw secret is never stored client-side.
  app.post('/api/login', async (req, reply) => {
    if (!authDisabled()) {
      const body = (req.body ?? {}) as { token?: string };
      const supplied = body.token ?? extractToken(req);
      if (supplied !== config.token) {
        return reply.code(401).send({ error: 'Invalid token' });
      }
    }
    const ua = req.headers['user-agent'];
    const { token } = logins.create(typeof ua === 'string' ? ua : undefined);
    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    return { ok: true };
  });

  // Log out this device: revoke its token and clear the cookie.
  app.post('/api/logout', async (req, reply) => {
    logins.revokeToken(sessionToken(req));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // List logged-in devices, marking the current one.
  app.get('/api/devices', async (req) => {
    return { devices: logins.list(sessionToken(req)) };
  });

  // Revoke a device by id. Revoking the current device also clears its cookie.
  app.delete('/api/devices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = logins.list(sessionToken(req)).find((d) => d.current);
    const removed = logins.revokeId(id);
    if (current?.id === id) reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: removed };
  });

  // Log out everywhere: revoke all devices and clear this cookie.
  app.post('/api/logout-all', async (_req, reply) => {
    logins.revokeAll();
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Static assets, health, and the login endpoint itself are public.
    if (!req.url.startsWith('/api/')) return;
    if (req.url === '/api/health' || req.url === '/api/login') return;
    if (authDisabled()) return;
    if (hasValidSession(req)) return; // verify() already slid the expiry forward
    reply.code(401).send({ error: 'Unauthorized: log in first' });
  });
}
