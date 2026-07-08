import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@casper/shared';
import type { SessionManager } from '../session/SessionManager.js';

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

/** Route an inbound client control message to the SessionManager. */
export async function handleClientMessage(
  socket: WebSocket,
  manager: SessionManager,
  sessionId: string,
  msg: ClientMessage,
): Promise<void> {
  switch (msg.type) {
    case 'ping':
      send(socket, { type: 'pong' });
      return;

    case 'hello':
      // Handshake handled at connect time via query params; no-op here.
      return;

    case 'prompt':
      try {
        await manager.runPrompt(sessionId, msg.content);
        send(socket, { type: 'ack', action: 'prompt', ok: true });
      } catch (err) {
        send(socket, {
          type: 'ack',
          action: 'prompt',
          ok: false,
          error: (err as Error).message,
        });
      }
      return;

    case 'cancel':
      try {
        manager.cancel(sessionId);
        send(socket, { type: 'ack', action: 'cancel', ok: true });
      } catch (err) {
        send(socket, {
          type: 'ack',
          action: 'cancel',
          ok: false,
          error: (err as Error).message,
        });
      }
      return;

    case 'set_mode':
      try {
        await manager.setMode(sessionId, msg.modeId);
        send(socket, { type: 'ack', action: 'set_mode', ok: true });
      } catch (err) {
        send(socket, {
          type: 'ack',
          action: 'set_mode',
          ok: false,
          error: (err as Error).message,
        });
      }
      return;

    case 'set_model':
      try {
        await manager.setModel(sessionId, msg.modelId);
        send(socket, { type: 'ack', action: 'set_model', ok: true });
      } catch (err) {
        send(socket, {
          type: 'ack',
          action: 'set_model',
          ok: false,
          error: (err as Error).message,
        });
      }
      return;

    case 'exec_command':
      try {
        await manager.execCommand(sessionId, msg.command, msg.args);
        send(socket, { type: 'ack', action: 'exec_command', ok: true });
      } catch (err) {
        send(socket, {
          type: 'ack',
          action: 'exec_command',
          ok: false,
          error: (err as Error).message,
        });
      }
      return;

    default:
      send(socket, { type: 'error', message: `Unknown message type` });
  }
}
