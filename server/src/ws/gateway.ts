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

/** The socket surface a connection uses; `ws`'s WebSocket satisfies it, and so can a test double. */
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

/** What a connection needs from SessionManager, narrower than the class so a test
 *  can drive it with a stub. */
export interface GatewayChats {
  ensureOpen(chatId: string): Promise<unknown>;
  getStore(chatId: string): EventStore | undefined;
  onEvent(chatId: string, cb: (e: CasperEvent) => void): (() => void) | null;
  getChatCwd(chatId: string): Promise<string>;
  runPrompt(
    chatId: string,
    content: PromptContentBlock[],
    attachments?: MessageAttachment[],
  ): Promise<void>;
  cancel(chatId: string): void;
  setMode(chatId: string, modeId: string): Promise<void>;
  setModel(chatId: string, modelId: string): Promise<void>;
  execCommand(chatId: string, command: string, args?: string): Promise<void>;
}

/** One client connection: replays events after its cursor, streams live ones, answers
 *  control messages. Takes the socket rather than a Fastify request, so a test can drive it. */
export function handleConnection(
  socket: GatewaySocket,
  manager: GatewayChats,
  chatId: string,
  startCursor: number,
): void {
  let cursor = startCursor;
  let unsubscribe: (() => void) | null = null;
  let alive = true;
  let ready = false;

  // Resolved per event since a session can be re-pointed to another cwd mid-socket.
  const watchers = createDirWatchers({
    resolve: async (relative) => {
      try {
        return confineToRoot(await manager.getChatCwd(chatId), relative);
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
    try {
      await manager.ensureOpen(chatId);
    } catch (err) {
      send(socket, { type: 'error', message: (err as Error).message });
      socket.close(1011, 'open failed');
      return;
    }

    const store = manager.getStore(chatId);
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

    unsubscribe = manager.onEvent(chatId, forward);
    ready = true;
  };

  void attach();

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
        return ack('prompt', () => manager.runPrompt(chatId, msg.content, msg.attachments));
      case 'cancel':
        return ack('cancel', () => manager.cancel(chatId));
      case 'set_mode':
        return ack('set_mode', () => manager.setMode(chatId, msg.modeId));
      case 'set_model':
        return ack('set_model', () => manager.setModel(chatId, msg.modelId));
      case 'exec_command':
        return ack('exec_command', () =>
          manager.execCommand(chatId, msg.command),
        );
      default:
        return send(socket, { type: 'error', message: 'Unknown message type' });
    }
  };

  // Drops dead sockets without touching the process.
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

// WebSocket gateway at /ws?chatId=&cursor=. Auth is the same-origin session cookie
// on the upgrade request. Socket loss never touches the child process.
export function registerWsGateway(app: FastifyInstance, manager: SessionManager): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    const query = req.query as { chatId?: string; cursor?: string };

    if (!authDisabled() && !hasValidSession(req)) {
      send(socket, { type: 'error', message: 'Unauthorized' });
      socket.close(1008, 'Unauthorized');
      return;
    }

    if (!query.chatId) {
      send(socket, { type: 'error', message: 'Missing chatId' });
      socket.close(1008, 'Missing chatId');
      return;
    }

    handleConnection(
      socket,
      manager,
      query.chatId,
      Number.parseInt(query.cursor ?? '0', 10) || 0,
    );
  });
}
