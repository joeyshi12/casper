import fs from 'node:fs';

/** Ceiling on watches per connection, so a client cannot ask for thousands. */
export const MAX_WATCHES = 64;

/** Coalesce a burst of events on one directory into a single change. */
const DEBOUNCE_MS = 200;

/** Which paths to start and stop watching to reach `next`. */
export function diffWatchSet(
  current: Iterable<string>,
  next: string[],
): { add: string[]; remove: string[] } {
  const have = new Set(current);
  const want = new Set(next.slice(0, MAX_WATCHES));
  return {
    add: [...want].filter((p) => !have.has(p)),
    remove: [...have].filter((p) => !want.has(p)),
  };
}

export interface DirWatchers {
  /** Watch exactly these paths, relative to the session's working directory. */
  sync(paths: string[]): Promise<void>;
  close(): void;
  watching(): string[];
}

/**
 * Watches the directories a client is actually showing, non-recursively, and reports
 * which one changed.
 *
 * The tree only ever displays expanded directories, so watching just those keeps this
 * to a handful of inotify handles. Watching the workspace recursively instead is what
 * makes editors hit the descriptor limit on a large tree.
 */
export function createDirWatchers(opts: {
  /** Absolute path for a relative one, or null when it escapes the workspace. */
  resolve: (relative: string) => Promise<string | null>;
  onChange: (relative: string) => void;
}): DirWatchers {
  const open = new Map<string, fs.FSWatcher>();
  const timers = new Map<string, NodeJS.Timeout>();
  let closed = false;

  const stop = (relative: string) => {
    open.get(relative)?.close();
    open.delete(relative);
    const t = timers.get(relative);
    if (t) clearTimeout(t);
    timers.delete(relative);
  };

  const start = async (relative: string) => {
    const target = await opts.resolve(relative);
    if (!target || closed) return;
    try {
      const watcher = fs.watch(target, { persistent: false }, () => {
        const existing = timers.get(relative);
        if (existing) clearTimeout(existing);
        timers.set(
          relative,
          setTimeout(() => {
            timers.delete(relative);
            if (!closed) opts.onChange(relative);
          }, DEBOUNCE_MS),
        );
      });
      // A watched directory can be renamed or deleted; drop it rather than throwing.
      watcher.on('error', () => stop(relative));
      open.set(relative, watcher);
    } catch {
      // Gone, or not readable. The next listing will report it.
    }
  };

  return {
    async sync(paths) {
      if (closed) return;
      const { add, remove } = diffWatchSet(open.keys(), paths);
      remove.forEach(stop);
      await Promise.all(add.map(start));
    },
    close() {
      closed = true;
      [...open.keys()].forEach(stop);
    },
    watching() {
      return [...open.keys()];
    },
  };
}
