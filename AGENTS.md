# AGENTS.md

Casper is a web client for `kiro-cli` over the Agent Client Protocol. A long task keeps running
server-side; on reconnect the client replays what it missed. npm workspaces: `shared/` (types),
`web/` (React app), `server/` (Fastify server, and the package published to npm).

This file is loaded into every turn's context. Keep additions short and durable.

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
- Tests live in `tests/` and import from source. The runner **cannot import components** (tsx uses the
  classic JSX runtime), so put parsers and pure logic in `web/src/util/` where they can be tested.
- Throwaway probe scripts must sit inside the repo to resolve modules. Delete them when done.

## Code style

- Keep logic simple but not fragile. Comments should be used sparingly and should stay short.
- Match existing style and dependencies. A new dependency needs a reason.
- Prefer deleting to deprecating; there is no external API to keep stable.
- Fix causes, not symptoms, and keep a change no larger than the problem.

## Commits and PRs

- Commit only when asked. Push only when asked: each push is authorised once, not standing permission.
- Pushes go straight to `main`; this project doesn't use PRs.
- The body says what was wrong and why the change fixes it, wrapped at ~90 columns.

## Security

- Casper launches kiro with `--trust-all-tools`, so access to Casper is equivalent to a shell on the
  machine. Treat any new network-reachable route as needing auth.
- The token is stored hashed, compared in constant time, and `/api/login` is rate-limited. The settings
  file and `casper.db` are `0600`. Don't widen either.
- File endpoints are confined to `config.fileRoot`; keep new filesystem routes inside that check.

## Design taste

- Widgets and animations may move, but **never change height**. Layout shift is the unforgivable bug.
- A global `prefers-reduced-motion` rule neutralises animation with `!important`. No per-selector overrides.
- Prefer SVG icons over character icons.

## Architecture notes

- **Sessions live in kiro's files**, `~/.kiro/sessions/cli/<id>.{json,jsonl}`. `casper.db` holds only
  title/cwd overrides and login hashes. kiro writes a session file when a turn completes, not at
  creation, so a brand-new session legitimately has no file (see `isGhost` in `SessionManager`).
- **One title resolver**, `shared/src/titles.ts`. Don't add a second precedence chain.
- Store updates go through `applyEvent`, which drops anything whose `seq` it has seen. Work that
  bypasses it is discarded silently.
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
