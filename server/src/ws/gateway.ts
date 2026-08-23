import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { CasperEvent, ClientMessage, ServerMessage } from '@casper/shared';
import type { MessageAttachment, PromptContentBlock } from '@casper/shared';
import type { EventStore } from '../session/EventStore.js';
import type { SessionManager } from '../session/SessionManager.js';
import { authDisabled, hasValidSession } from '../routes/auth.js';
import { createDirWatchers } from './dirWatchers.js';
import { confineToRoot } from '../util/paths.js';

const HEARTBEAT_MS = 20_000;

/**
 * The socket surface a connection uses. `ws`'s WebSocket satisfies it, and so
 * can a test double - which is the point.
 */
export interface GatewaySocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', cb: (raw: Buffer) => void): unknown;
  on(event: 'pong', cb: () => void): unknown;
  on(event: 'close', cb: () => void): unknown;
}

export function send(socket: GatewaySocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

/**
 * What a connection needs from SessionManager. Narrower than the class so a
 * test can drive a connection with a stub instead of a kiro process.
 */
export interface GatewaySessions {
  ensureOpen(sessionId: string): Promise<unknown>;
  getStore(sessionId: string): EventStore | undefined;
  onEvent(sessionId: string, cb: (e: CasperEvent) => void): (() => void) | null;
  getSessionCwd(sessionId: string): Promise<string>;
  runPrompt(
    sessionId: string,
    content: PromptContentBlock[],
    attachments?: MessageAttachment[],
  ): Promise<void>;
  cancel(sessionId: string): void;
  setMode(sessionId: string, modeId: string): Promise<void>;
  setModel(sessionId: string, modelId: string): Promise<void>;
  execCommand(sessionId: string, command: string, args?: string): Promise<void>;
}

/**
 * One client connection: replay the events after its cursor, then stream live
 * ones and answer control messages. Owns everything per-socket - cursor,
 * readiness, heartbeat, directory watchers and the control-message table - so
 * the state and the messages that mutate it stay in one module.
 *
 * Takes the socket rather than a Fastify request, so a test can drive it.
 */
export function handleConnection(
  socket: GatewaySocket,
  manager: GatewaySessions,
  sessionId: string,
  startCursor: number,
): void {
  let cursor = startCursor;
  let unsubscribe: (() => void) | null = null;
  let alive = true;
  let ready = false;

  // Watches the directories this client has open, so the file panel updates itself.
  // Resolved per event rather than once: a session can be re-pointed at another
  // working directory while the socket lives.
  const watchers = createDirWatchers({
    resolve: async (relative) => {
      try {
        return confineToRoot(await manager.getSessionCwd(sessionId), relative);
      } catch {
        return null;
      }
    },
    onChange: (path) => send(socket, { type: 'fs_changed', path }),
  });

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

    unsubscribe = manager.onEvent(sessionId, forward);
    ready = true;
  };

  void attach();

  // Every control action answers with the same ack shape, success or failure.
  const ack = async (action: string, run: () => Promise<void> | void): Promise<void> => {
    try {
      await run();
      send(socket, { type: 'ack', action, ok: true });
    } catch (err) {
      send(socket, { type: 'ack', action, ok: false, error: (err as Error).message });
    }
  };

  const handle = (msg: ClientMessage): Promise<void> | void => {
    switch (msg.type) {
      case 'ping':
        return send(socket, { type: 'pong' });
      case 'watch_paths':
        return watchers.sync(msg.paths);
      case 'prompt':
        return ack('prompt', () => manager.runPrompt(sessionId, msg.content, msg.attachments));
      case 'cancel':
        return ack('cancel', () => manager.cancel(sessionId));
      case 'set_mode':
        return ack('set_mode', () => manager.setMode(sessionId, msg.modeId));
      case 'set_model':
        return ack('set_model', () => manager.setModel(sessionId, msg.modelId));
      case 'exec_command':
        return ack('exec_command', () =>
          manager.execCommand(sessionId, msg.command, msg.args),
        );
      default:
        return send(socket, { type: 'error', message: 'Unknown message type' });
    }
  };

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
    // Ignore anything sent before attach() finished opening the session, so a
    // prompt can't hit an unopened session and reject unhandled.
    if (!ready) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(socket, { type: 'error', message: 'Invalid JSON' });
      return;
    }
    void handle(msg);
  });

  socket.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe?.();
    watchers.close();
  });
}

// WebSocket gateway at /ws?sessionId=&cursor=. Auth is the same-origin session
// cookie sent on the upgrade request. On connect it replays buffered events
// after the client's cursor, then streams live ones. Socket loss never touches
// the child process, so the turn keeps running.
export function registerWsGateway(app: FastifyInstance, manager: SessionManager): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    const query = req.query as { sessionId?: string; cursor?: string };

    if (!authDisabled() && !hasValidSession(req)) {
      send(socket, { type: 'error', message: 'Unauthorized' });
      socket.close(1008, 'Unauthorized');
      return;
    }

    if (!query.sessionId) {
      send(socket, { type: 'error', message: 'Missing sessionId' });
      socket.close(1008, 'Missing sessionId');
      return;
    }

    handleConnection(
      socket,
      manager,
      query.sessionId,
      Number.parseInt(query.cursor ?? '0', 10) || 0,
    );
  });
}
