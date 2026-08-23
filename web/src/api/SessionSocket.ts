import type {
  CasperEvent,
  ClientMessage,
  PromptContentBlock,
  ServerMessage,
} from '@casper/shared';

import { shouldPing, shouldReconnect } from './socketHealth.js';
import type { MessageAttachment } from '@casper/shared';

export type ConnStatus =
  | 'connecting'
  | 'replaying'
  | 'connected'
  | 'reconnecting'
  | 'resyncing'
  | 'closed';

export interface SessionSocketHandlers {
  onEvent: (event: CasperEvent) => void;
  onStatus: (status: ConnStatus) => void;
  /** Cursor is stale - caller should refetch the full session, then call reset(head). */
  onResync: () => void;
  onAck?: (action: string, ok: boolean, error?: string) => void;
  /** A server-level error frame (bad request, session unavailable). Reported so
   *  the user sees a reason instead of it only reaching the console. */
  onServerError?: (message: string) => void;
  /** The server rejected the connection as unauthorized (expired/absent session). */
  onUnauthorized?: () => void;
  /** A directory this client asked to watch changed on disk. */
  onFsChanged?: (path: string) => void;
}

// WebSocket close code the server uses for an unauthorized upgrade (policy
// violation). Reconnecting can't fix this, so we stop and surface it instead.
const WS_UNAUTHORIZED = 1008;

// Resumable WebSocket client. Tracks the highest applied seq as its cursor; on
// disconnect it reconnects with backoff and the server replays the gap. Also
// reconnects when the tab becomes visible or the network returns.
export class SessionSocket {
  private ws: WebSocket | null = null;
  private cursor = 0;
  private closedByUser = false;
  private backoff = 500;
  private reconnectTimer: number | null = null;
  private connectingSince = 0;
  private lastMessageAt = 0;
  private watchdog: number | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly handlers: SessionSocketHandlers,
    startCursor = 0,
  ) {
    this.cursor = startCursor;
    window.addEventListener('online', this.eager);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  // Reconnect only when the socket is past saving. Leaving a live connect alone is
  // what stops a waking phone, which fires 'online' and 'visibilitychange' together,
  // opening two sockets.
  private eager = () => {
    if (this.closedByUser) return;
    if (shouldReconnect(this.sample())) this.connect();
  };

  private sample() {
    return {
      state: this.ws?.readyState,
      connectingSince: this.connectingSince,
      lastMessageAt: this.lastMessageAt,
      now: Date.now(),
    };
  }

  /** The only thing that notices a socket which neither opens nor closes. */
  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = window.setInterval(() => {
      if (this.closedByUser) return;
      const s = this.sample();
      if (shouldReconnect(s)) this.connect();
      else if (shouldPing(s)) this.send({ type: 'ping' });
    }, 5_000);
  }

  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.eager();
  };

  /** Reset the replay cursor (after a full refetch triggered by resync). */
  reset(head: number): void {
    this.cursor = head;
  }

  connect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Drop any socket we already have before opening another: waking a phone fires 'online' and
    // 'visibilitychange' together, and a dying socket's onclose schedules its own retry, so
    // connect() can be re-entered while one is still live. Each connection carries its own replay
    // cursor, so a leaked socket delivers every event twice. Null the handlers first, or the close
    // we trigger here schedules yet another reconnect.
    const stale = this.ws;
    if (stale) {
      this.ws = null;
      stale.onopen = null;
      stale.onmessage = null;
      stale.onclose = null;
      stale.onerror = null;
      if (stale.readyState === WebSocket.OPEN || stale.readyState === WebSocket.CONNECTING) {
        stale.close();
      }
    }

    this.connectingSince = Date.now();
    this.lastMessageAt = Date.now(); // nothing to judge as silence until it opens
    this.startWatchdog();
    this.handlers.onStatus(this.cursor > 0 ? 'reconnecting' : 'connecting');

    // No token in the URL: the same-origin session cookie authenticates the
    // WS upgrade request automatically.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url =
      `${proto}://${location.host}/ws?sessionId=${encodeURIComponent(this.sessionId)}` +
      `&cursor=${this.cursor}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.backoff = 500;
      this.handlers.onStatus('replaying');
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      const msg = JSON.parse(ev.data as string) as ServerMessage;
      switch (msg.type) {
        case 'event':
          if (msg.event.seq > this.cursor) {
            this.cursor = msg.event.seq;
            this.handlers.onEvent(msg.event);
          }
          break;
        case 'replay_complete':
          this.handlers.onStatus('connected');
          break;
        case 'resync':
          this.handlers.onStatus('resyncing');
          this.handlers.onResync();
          break;
        case 'ack':
          this.handlers.onAck?.(msg.action, msg.ok, msg.error);
          break;
        case 'error':
          console.warn('ws error:', msg.message);
          this.handlers.onServerError?.(msg.message);
          break;
        case 'fs_changed':
          this.handlers.onFsChanged?.(msg.path);
          break;

        case 'pong':
          break;
      }
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      if (this.closedByUser) {
        this.handlers.onStatus('closed');
        return;
      }
      // An auth rejection won't heal by retrying - stop the loop and tell the
      // app so it can send the user back to the login screen.
      if (ev.code === WS_UNAUTHORIZED) {
        this.closedByUser = true;
        this.handlers.onStatus('closed');
        this.handlers.onUnauthorized?.();
        return;
      }
      this.handlers.onStatus('reconnecting');
      this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 1.7, 10_000);
    };

    ws.onerror = () => {
      if (this.ws === ws) ws.close();
    };
  }

  private send(msg: ClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Returns false if the socket wasn't open, so the caller can flag failure. */
  prompt(content: PromptContentBlock[], attachments?: MessageAttachment[]): boolean {
    return this.send({ type: 'prompt', content, attachments });
  }
  cancel(): void {
    this.send({ type: 'cancel' });
  }
  setMode(modeId: string): void {
    this.send({ type: 'set_mode', modeId });
  }
  setModel(modelId: string): void {
    this.send({ type: 'set_model', modelId });
  }
  /** Declare which directories the file panel is showing; replaces the previous set. */
  watchPaths(paths: string[]): void {
    this.send({ type: 'watch_paths', paths });
  }
  execCommand(command: string, args?: string): void {
    this.send({ type: 'exec_command', command, args });
  }

  close(): void {
    this.closedByUser = true;
    window.removeEventListener('online', this.eager);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
  }
}
