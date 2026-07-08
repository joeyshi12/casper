import type {
  CasperEvent,
  ClientMessage,
  PromptContentBlock,
  ServerMessage,
} from '@casper/shared';
import { getToken } from './rest.js';

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
}

// Resumable WebSocket client. Tracks the highest applied seq as its cursor; on
// disconnect it reconnects with backoff and the server replays the gap. Also
// reconnects when the tab becomes visible or the network returns.
export class SessionSocket {
  private ws: WebSocket | null = null;
  private cursor = 0;
  private closedByUser = false;
  private backoff = 500;
  private reconnectTimer: number | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly handlers: SessionSocketHandlers,
    startCursor = 0,
  ) {
    this.cursor = startCursor;
    window.addEventListener('online', this.eager);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private eager = () => {
    if (!this.closedByUser && this.ws?.readyState !== WebSocket.OPEN) this.connect();
  };

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
    this.handlers.onStatus(this.cursor > 0 ? 'reconnecting' : 'connecting');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = getToken();
    const url =
      `${proto}://${location.host}/ws?sessionId=${encodeURIComponent(this.sessionId)}` +
      `&cursor=${this.cursor}` +
      (token ? `&token=${encodeURIComponent(token)}` : '');

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.handlers.onStatus('replaying');
      this.send({ type: 'hello', sessionId: this.sessionId, cursor: this.cursor });
    };

    ws.onmessage = (ev) => {
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
          break;
        case 'pong':
          break;
      }
    };

    ws.onclose = () => {
      if (this.closedByUser) {
        this.handlers.onStatus('closed');
        return;
      }
      this.handlers.onStatus('reconnecting');
      this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 1.7, 10_000);
    };

    ws.onerror = () => ws.close();
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  prompt(content: PromptContentBlock[]): void {
    this.send({ type: 'prompt', content });
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
  execCommand(command: string, args?: string): void {
    this.send({ type: 'exec_command', command, args });
  }

  close(): void {
    this.closedByUser = true;
    window.removeEventListener('online', this.eager);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
