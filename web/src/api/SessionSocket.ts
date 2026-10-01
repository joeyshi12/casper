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
  onServerError?: (message: string) => void;
  onUnauthorized?: () => void;
  onFsChanged?: (path: string) => void;
}

// 1008 (policy violation) is the server's close code for an unauthorized upgrade.
// Reconnecting can't fix this, so stop and surface it instead.
const WS_UNAUTHORIZED = 1008;

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
    private readonly chatId: string,
    private readonly handlers: SessionSocketHandlers,
    startCursor = 0,
  ) {
    this.cursor = startCursor;
    window.addEventListener('online', this.eager);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /* Reconnect only when the socket is past saving. A waking phone fires 'online'
     and 'visibilitychange' together; leaving a live connect alone avoids opening
     two sockets. */
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

  reset(head: number): void {
    this.cursor = head;
  }

  connect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    /* connect() can be re-entered while a socket is still live (waking a phone fires
       'online' and 'visibilitychange' together; a dying socket's onclose also
       schedules a retry). Null the handlers first, or this close schedules another
       reconnect. */
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
    this.lastMessageAt = Date.now();
    this.startWatchdog();
    this.handlers.onStatus(this.cursor > 0 ? 'reconnecting' : 'connecting');

    // The same-origin session cookie authenticates the WS upgrade automatically;
    // no token needed in the URL.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url =
      `${proto}://${location.host}/ws?chatId=${encodeURIComponent(this.chatId)}` +
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
  watchPaths(paths: string[]): void {
    this.send({ type: 'watch_paths', paths });
  }
  execCommand(command: string): void {
    this.send({ type: 'exec_command', command });
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
