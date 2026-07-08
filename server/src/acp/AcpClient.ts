import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import split2 from 'split2';
import {
  isJsonRpcError,
  isJsonRpcNotification,
  isJsonRpcResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from '@casper/shared';
import type { Logger } from '../util/logger.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  timer?: NodeJS.Timeout;
}

export interface AcpClientEvents {
  notification: (n: JsonRpcNotification) => void;
  /** A request initiated by the agent toward the client (rare; we ack minimally). */
  serverRequest: (r: JsonRpcRequest) => void;
  parseError: (err: Error, line: string) => void;
}

// JSON-RPC 2.0 client over newline-delimited JSON on kiro-cli acp's stdio.
// Never end the writable stream except on shutdown: kiro-cli exits as soon as
// its stdin hits EOF.
export class AcpClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly writable: Writable;
  private readonly log: Logger;
  private closed = false;

  constructor(readable: Readable, writable: Writable, log: Logger) {
    super();
    this.writable = writable;
    this.log = log;

    readable.pipe(split2()).on('data', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch (err) {
        this.emit('parseError', err as Error, trimmed);
        this.log.warn({ line: trimmed.slice(0, 200) }, 'acp: failed to parse line');
        return;
      }
      this.handleMessage(msg);
    });
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (isJsonRpcResponse(msg)) {
      const id = 'id' in msg ? msg.id : null;
      if (id === null) return;
      const pending = this.pending.get(id);
      if (!pending) {
        this.log.warn({ id }, 'acp: response for unknown request id');
        return;
      }
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (isJsonRpcError(msg)) {
        pending.reject(
          new Error(
            `ACP ${pending.method} failed: ${msg.error.message} (code ${msg.error.code})`,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (isJsonRpcNotification(msg)) {
      this.emit('notification', msg);
      return;
    }

    // A request from the agent to the client (has both id and method).
    if ('id' in msg && 'method' in msg) {
      this.emit('serverRequest', msg as JsonRpcRequest);
    }
  }

  /** Send a request and await its result. */
  request<R = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = 120_000,
  ): Promise<R> {
    if (this.closed) return Promise.reject(new Error('ACP client is closed'));
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<R>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
        timer,
      });
      this.write(payload);
    });
  }

  /** Send a fire-and-forget notification. */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Respond to an agent-initiated request. */
  respond(id: JsonRpcId, result: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, result });
  }

  private write(msg: object): void {
    this.writable.write(JSON.stringify(msg) + '\n');
  }

  /** Reject all pending requests; call when the child process exits. */
  fail(reason: string): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(`ACP client closed: ${reason}`));
      this.pending.delete(id);
    }
  }
}
