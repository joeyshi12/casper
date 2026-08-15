/**
 * When a socket needs replacing. Kept pure so the awkward cases - a connect that
 * never resolves, an open socket whose peer is gone - are testable without a
 * browser or a network.
 */

/** WebSocket.readyState values, spelled out so this module needs no DOM. */
export const READY = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;

/** Give up on a connect that has not opened by now. */
export const CONNECT_TIMEOUT_MS = 8_000;
/** Send a ping once a socket has been silent this long. */
export const PING_AFTER_MS = 25_000;
/** How long after that to wait for any reply before calling the socket dead. */
export const PONG_GRACE_MS = 10_000;

export interface SocketSample {
  /** readyState, or undefined when there is no socket at all. */
  state: number | undefined;
  /** When the current connect attempt started. */
  connectingSince: number;
  /** When anything was last received on this socket. */
  lastMessageAt: number;
  now: number;
}

/**
 * A connecting socket used to be treated as in-flight and left alone, which
 * stopped a waking phone opening a second one. But the browser can freeze a
 * pending connect across a suspend, and then it never opens and never closes:
 * no retry is ever scheduled, and the UI sits on "Reconnecting" forever. So it
 * counts as in-flight only until the timeout.
 */
export function shouldReconnect(s: SocketSample): boolean {
  if (s.state === undefined || s.state === READY.CLOSED || s.state === READY.CLOSING) {
    return true;
  }
  if (s.state === READY.CONNECTING) {
    return s.now - s.connectingSince > CONNECT_TIMEOUT_MS;
  }
  // Open, but silence outlasting a ping and its grace means the peer is gone.
  // The server pings at the protocol level and drops us; this is the same
  // judgement from the client's side, which otherwise cannot tell.
  return s.now - s.lastMessageAt > PING_AFTER_MS + PONG_GRACE_MS;
}

/** Whether an open, quiet socket is due a ping. */
export function shouldPing(s: SocketSample): boolean {
  return s.state === READY.OPEN && s.now - s.lastMessageAt > PING_AFTER_MS;
}
