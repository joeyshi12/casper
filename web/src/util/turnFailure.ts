/**
 * Turn failures arrive as whatever the server threw - usually kiro's exit line
 * plus the tail of its stderr. That's the truth and it's always shown verbatim,
 * but on its own it doesn't tell the user what to do about it. These patterns
 * add a plain-language cause and a remedy for the failures worth recognising.
 *
 * Deliberately narrow: anything unrecognised gets no invented advice, just the
 * raw text under a neutral heading.
 */
interface TurnFailure {
  /** Short heading for the failure. */
  title: string;
  /** What to do about it, if we can say something useful. */
  fix?: string;
  /** True for conditions that outlive the turn and can't be fixed in the UI, so
   *  the session shows a pinned notice as well as the transcript entry. */
  sessionWide?: boolean;
}

export function classifyTurnFailure(message: string): TurnFailure {
  const m = message.toLowerCase();

  // kiro exits when its cached credentials lapse. The user has to re-auth on the
  // host - nothing in this UI can do it for them.
  if (
    m.includes('credential') ||
    m.includes('expired') ||
    m.includes('not authenticated') ||
    m.includes('unauthorized') ||
    m.includes('kiro-cli login')
  ) {
    return {
      title: "Kiro isn't authenticated",
      fix: 'Run `kiro-cli login` on the server, then retry.',
      sessionWide: true,
    };
  }

  if (m.includes('a turn is already running')) {
    return {
      title: 'A turn is already running',
      fix: 'Wait for the current turn to finish, or stop it first.',
    };
  }

  // The binary itself is missing or unusable, so every turn will fail the same way.
  if (m.includes('enoent') || m.includes('spawn') || m.includes('command not found')) {
    return {
      title: "Couldn't start kiro-cli",
      fix: 'Check that KIRO_BIN points at an executable kiro-cli.',
      sessionWide: true,
    };
  }

  if (m.includes('timed out')) {
    return { title: 'The request timed out' };
  }

  return { title: 'Turn failed' };
}
