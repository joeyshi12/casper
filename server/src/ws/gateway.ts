import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type {
  CasperEvent,
  ClientMessage,
  ServerMessage,
} from '@casper/shared';
import type { SessionManager } from '../session/SessionManager.js';
import { authDisabled, hasValidSession } from '../routes/auth.js';
import { handleClientMessage } from './dispatch.js';

const HEARTBEAT_MS = 20_000;

// WebSocket gateway at /ws?sessionId=&cursor=. Auth is the same-origin session
// cookie sent on the upgrade request. On connect it replays buffered events
// after the client's cursor, then streams live ones. Socket loss never touches
// the child process, so the turn keeps running.
export function registerWsGateway(
  app: FastifyInstance,
  manager: SessionManager,
): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    const query = req.query as {
      sessionId?: string;
      cursor?: string;
    };

    if (!authDisabled() && !hasValidSession(req)) {
      send(socket, { type: 'error', message: 'Unauthorized' });
      socket.close(1008, 'Unauthorized');
      return;
    }

    const sessionId = query.sessionId;
    if (!sessionId) {
      send(socket, { type: 'error', message: 'Missing sessionId' });
      socket.close(1008, 'Missing sessionId');
      return;
    }

    let cursor = Number.parseInt(query.cursor ?? '0', 10) || 0;
    let unsubscribe: (() => void) | null = null;
    let alive = true;

    const forward = (event: CasperEvent) => {
      if (event.seq <= cursor) return; // dedupe against replay overlap
      cursor = event.seq;
      send(socket, { type: 'event', event });
    };

    const attach = async () => {
      // Open the session in memory WITHOUT spawning a kiro process - viewing is
      // instant. A process is spawned lazily only when the user sends a prompt.
      try {
        await manager.ensureOpen(sessionId);
      } catch (err) {
        send(socket, { type: 'error', message: (err as Error).message });
        socket.close(1011, 'open failed');
        return;
      }

      const store = manager.getStore(sessionId);
      if (!store) {
        send(socket, { type: 'error', message: 'Session store unavailable' });
        socket.close(1011, 'no store');
        return;
      }

      // Replay buffered events after the cursor.
      const { events, gap } = store.getSince(cursor);
      if (gap) {
        send(socket, {
          type: 'resync',
          reason: 'cursor older than buffer; refetch full transcript',
        });
        cursor = store.head();
      } else {
        for (const e of events) forward(e);
      }
      send(socket, { type: 'replay_complete', head: store.head() });

      // Subscribe to live events.
      unsubscribe = manager.onEvent(sessionId, forward);
    };

    void attach();

    // Heartbeat: drop dead sockets, but leave the process alone.
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    socket.on('pong', () => {
      alive = true;
    });

    socket.on('message', (raw: Buffer) => {
      alive = true;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send(socket, { type: 'error', message: 'Invalid JSON' });
        return;
      }
      void handleClientMessage(socket, manager, sessionId, msg);
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    });
  });
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}
