# AGENTS.md

Casper is a web client for `kiro-cli` over the Agent Client Protocol: a long task keeps running
server-side, and on reconnect the client replays what it missed.

Node 24+ (for `node:sqlite`). npm workspaces: `shared/` types, `web/` React 18 + zustand 5 +
Vite 6, `server/` Fastify 5 + ws — and `server/` is the package published to npm.

**What Casper does, how to install and configure it, and the full settings table live in
[README.md](README.md).** Facts belong there once; this file is procedure, rules and the things
that are only learned the hard way. It is loaded into every turn's context, so keep additions
short and durable.

## Setup and commands

```bash
npm install
CASPER_TOKEN=dev npm run dev   # server and web dev servers together
npm run build                  # bundles the server with esbuild, copies the built web app in
npm test                       # node --test over tests/**/*.test.ts via tsx
npm run e2e                    # prompt, disconnect mid-turn, reconnect, replay
npm run typecheck              # all workspaces
```

`unset NODE_ENV` first: a stray `production` breaks installs and builds here.

## Testing and verification

- Run `npm run build`, `npm test`, and `npm run typecheck` before reporting a change as done. For
  unused code too: `npx tsc -p <ws>/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`.
- Never report a pass you didn't watch happen. Quote the failing command instead.
- Tests live in `tests/` and import from source. Components *can* be imported (`web/tsconfig.json`
  sets `jsx: react-jsx`); rendering one needs a DOM, and `jsdom` is already a dependency —
  `tests/widget.test.ts` shows the pattern.
- Each test file gets its own process, so anything sharing state across files contends: point
  `config.casperDataDir` and `config.kiroSessionsDir` at per-file temp directories rather than the
  developer's real ones.
- Don't assert on a fixed sleep. Poll to a deadline, or the suite passes locally and fails on CI.
- Throwaway probe scripts must sit inside the repo to resolve modules. Delete them when done.

## Code style

- Keep logic simple but not fragile. Comments should be used sparingly and should stay short.
- Match existing style and dependencies. A new dependency needs a reason.
- Prefer deleting to deprecating; there is no external API to keep stable.
- Fix causes, not symptoms, and keep a change no larger than the problem.

## Commits and PRs

- Commit only when asked. Push only when asked: each push is authorised once, not standing permission.
- Keep each commit small and auditable: one reviewable idea that stands on its own. Split unrelated
  concerns even when they arrive together.
- Work lands through a PR from a branch, not a push to `main`. Keep titles under 70 characters and put
  the detail in the description: what changed, what was tested, anything left blocked.
- Group tightly coupled commits into one PR. A change and its tests, or a refactor and the note that
  explains it, review better together than apart; only genuinely independent work gets its own PR.
- More than one PR means a stack, so the set merges together once review is done: `gh stack init
  <bottom..top>` adopts the branches, then `gh stack submit` registers the stack. Chaining `--base` by
  hand is not a stack - without submit there is nothing to merge as a unit, and `gh stack view` is how
  you check.
- The body says what was wrong and why the change fixes it, wrapped at ~90 columns.

## Boundaries

**Always**

- Verify with the project's own commands, and say which ones you ran.
- Keep new filesystem routes inside the `config.fileRoot` check.
- Treat any new network-reachable route as needing auth: Casper launches kiro with
  `--trust-all-tools`, so access to it is equivalent to a shell on the machine.

**Ask first**

- Committing, pushing, and anything that rewrites published history.
- Adding a dependency, or changing a security boundary, a status code, or an on-the-wire message.
- Restarting the service, or writing into the installed copy under the nvm prefix.

**Never**

- Widen the `0600` on the settings file or `casper.db`, or weaken how the token is stored and compared.
- Write into `~/.casper` from a test, or leave fixtures in the developer's real `~/.kiro`.
- Report a check as passing without having watched it pass.

## Design taste

- Widgets and animations may move, but **never change height**. Layout shift is the unforgivable bug.
- A global `prefers-reduced-motion` rule neutralises animation with `!important`. No per-selector overrides.
- Prefer SVG icons over character icons.

## Architecture notes

- **Sessions live in kiro's files**, `~/.kiro/sessions/cli/<id>.{json,jsonl}`. `casper.db` holds only
  title/cwd overrides and login hashes. kiro writes a session file when a turn completes, not at
  creation, so a brand-new session legitimately has no file (see `isGhost` in `SessionManager`).
- **One title resolver**, `shared/src/titles.ts`. Don't add a second precedence chain. The same goes
  for a session summary: `summaryOf` in `SessionManager` is the only place one is assembled.
- Store updates go through `applyEvent`, which drops anything whose `seq` it has seen. Work that
  bypasses it is discarded silently.
- **Confined file access** is one sequence in `server/src/util/confinedFile.ts`, and it takes two sets
  of roots on purpose: lexical (the session cwd, so `../` can't leave the project) and real (fileRoot,
  checked after symlinks). Collapsing them stops serving symlinks that legitimately leave a workspace.
- A `transform` on an ancestor becomes the containing block for `position: fixed`, which is why modals
  portal to `document.body`.
- The agent prompt is `assets/agents/prompt.txt`: plain text in XML-style sections, no markdown. It
  installs to `~/.kiro/agents/casper.json` at startup and only overwrites while the on-disk copy still
  hashes to Casper's stamp. kiro reads it at spawn, so changes need a restart *and* a new session.

## Install and restart

- The service runs the registry copy under the nvm prefix, not this checkout. Web assets are read per
  request, so swapping `dist/web` and refreshing is enough; server changes need a restart.
- The version is baked in at build time, so a hand-swapped `dist` misreports it.
- Restart only from a detached transient unit (`systemd-run --user --collect --unit=...`), because the
  chat itself runs inside `casper.service`. Do all verifiable work before dispatching it.
