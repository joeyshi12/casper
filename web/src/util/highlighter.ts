/**
 * Shiki's tokenizer is synchronous and costs roughly 9ms per KB, so highlighting
 * on the main thread freezes the app on anything sizeable. It runs in a worker
 * instead; callers already treat null as "render plain text".
 */
const MAX_HIGHLIGHT_CHARS = 256 * 1024;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (html: string | null) => void>();

function settle(id: number, html: string | null): void {
  pending.get(id)?.(html);
  pending.delete(id);
}

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./highlightWorker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (e: MessageEvent<{ id: number; html: string | null }>) =>
      settle(e.data.id, e.data.html),
    );
    // A dead worker must not leave callers hanging on a promise.
    worker.addEventListener('error', () => {
      for (const id of [...pending.keys()]) settle(id, null);
      worker = null;
    });
  } catch {
    return null;
  }
  return worker;
}

/** Highlighted HTML, or null when the caller should render the code as plain text. */
export async function highlightToHtml(code: string, lang: string): Promise<string | null> {
  // Past this size the colour isn't worth seconds of a core, even off-thread.
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const w = getWorker();
  if (!w) return null;
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, code, lang });
  });
}
