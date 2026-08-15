import type { JsonRpcError } from '@casper/shared';

/** Long enough for a stack or a nested cause, short enough not to flood the UI. */
const MAX_DETAIL = 2000;

/**
 * Flatten a JSON-RPC error into something a person can act on.
 *
 * kiro answers a failed session/prompt with "Internal error" and puts the real cause in
 * `data`, e.g. "No session found with id", so lead with `data` and keep the generic
 * classification in parentheses behind it.
 */
export function describeError(error: JsonRpcError['error']): string {
  const detail = detailText(error.data);
  return detail
    ? `${detail} (${error.message}, code ${error.code})`
    : `${error.message} (code ${error.code})`;
}

function detailText(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return truncate(data.trim());
  if (typeof data === 'number' || typeof data === 'boolean') return String(data);

  // Objects carry the detail under varying keys depending on the agent, so try
  // the common ones before falling back to the whole shape.
  if (typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', 'details', 'reason', 'cause']) {
      const v = rec[key];
      if (typeof v === 'string' && v.trim()) return truncate(v.trim());
    }
    try {
      return truncate(JSON.stringify(data));
    } catch {
      return '';
    }
  }
  return '';
}

const truncate = (s: string): string =>
  s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}… (truncated)` : s;
