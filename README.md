# Akko

An opinionated, minimalistic personal agentic system built on top of the
[pi](https://pi.dev) coding agent, with a first-party responsive web frontend
(Svelte 5 + bits-ui) and multiuser/multiplayer-capable design.

- **Runtime:** Bun (see [`docs/architecture/11-runtime-evaluation.md`](docs/architecture/11-runtime-evaluation.md)).
  Deno is a verified fallback; the only runtime-coupled seam is the SQLite driver
  behind `ConversationStore` (`packages/core/src/sqlite.ts`).
- **Design docs:** [`docs/architecture/`](docs/architecture/README.md) — read the
  index first. **Resuming work?** Start at
  [15 — Status and Roadmap](docs/architecture/15-status-and-roadmap.md).
- **Core interfaces (design skeleton):** [`packages/core/src`](packages/core/src),
  documented in [`docs/architecture/10-core-interfaces.md`](docs/architecture/10-core-interfaces.md).

## Status

Early implementation. `packages/core` holds the interfaces (the compilable shape of
the system, single-user today and multiuser-by-construction). `packages/runtime` has
the first working slice: id generation, an in-memory event bus, the per-session
mailbox (actor model), a session runtime + registry that drive pi via
`createAgentSession`, an in-memory conversation store, and a host workspace-runtime
factory.

**Verified end-to-end on Bun** (`bun test`): 62 tests green across `@akko/runtime`,
`@akko/server`, and `@akko/web` (backend + pure reducer), including SQLite (FTS5)
durability + rehydration, a canonical history endpoint, model routing (string resolver +
catalog), a live pi prompt, a **live WebSocket round-trip** (`AKKO_LIVE=1`), and the
frontend conversation reducer. The Svelte frontend adds **32 jsdom unit tests** (all five
components + the `AkkoClient` runes store, via vitest + `@testing-library/svelte`) and
**12 Storybook browser tests** (each story's `play` run under Playwright via
`@storybook/addon-vitest`), plus **Storybook 10** for designing components in isolation.
The web app type-checks (`svelte-check`) and builds (`vite build`). See the
implementation order in doc 10.

## Run it

One command brings up the whole dev stack. Two variants:

```bash
bun install
bun run dev        # server (:8787) + web (:5173)                  — no Jazz projection
bun run dev:jazz   # sync (:4200) + server + web, Jazz projection on — all 3 processes
# open http://localhost:5173
```

`dev:jazz` uses `concurrently` and a small `scripts/wait-port.mjs` gate so the backend
waits for the standalone Jazz server to be listening before it deploys its schema. The
individual processes are still available if you want separate terminals:
`bun run dev:sync`, `bun run dev:server`, `bun run dev:web`.

> **After any `@akko/schema` change, fully restart `dev:jazz`** (Ctrl-C, rerun). The
> in-memory sync server keeps its old schema catalogue and `dev:server` doesn't
> auto-restart (doc 14). Note the Jazz store is disposable: a restart wipes all projected
> rows, and the projector **backfills** a session's history from canonical SQLite when it
> first sees the session. A `CatalogueWriteDenied` warning in the browser console is
> expected and benign (the browser can't write the admin-owned schema catalogue).

Design components in isolation (optional, separate dev server):

```bash
bun --filter '@akko/web' storybook   # Storybook 10 on :6006
```

### Why is Jazz opt-in (`VITE_JAZZ`)?

Jazz is **not the source of truth** — SQLite is (doc 04). The app is fully functional
without it: the live chat streams over the WebSocket and renders from the conversation
reducer, and sessions persist/rehydrate from SQLite. Jazz (doc 14) is a *secondary,
synced read-model* — the backend projects **finalized** messages into a relational
`messages` table you can toggle to in the chat header ("Live" ↔ "Jazz").

So there genuinely are two modes, and each side is gated independently:

- **Backend** enables the projector only when `JAZZ_SYNC` + `JAZZ_APP_ID` +
  `JAZZ_BACKEND_SECRET` are set (otherwise it logs `jazz: disabled`).
- **Frontend** is a static Vite bundle, so it reads a build-time flag,
  **`VITE_JAZZ=1`** (exposed as `import.meta.env.VITE_JAZZ`). Only then does it create
  the `LocalFirstAuth` + Jazz client, wrap the app in `JazzSvelteProvider`, and show the
  Jazz view. Without a running sync server that setup would fail, so it must be opt-in.

Jazz is kept optional on purpose: `jazz-tools` is still `2.0.0-alpha` (pinned, expect
breaking changes), and it needs a third process + secrets — too much for the everyday
loop. Making Jazz the default read path is a future step (doc 15, item B.4).

**No `.env` is required** — `dev`/`dev:jazz` work with zero config, and model credentials
come from pi's agent dir (`~/.pi/agent/auth.json`), configured via pi itself. If you'd
rather not inline the vars (or you're pointing at real infra), copy
[`.env.example`](.env.example) to a git-ignored `.env`; a single root `.env` serves both
the backend (Bun auto-loads it) and the frontend (Vite reads `VITE_*` via `envDir`).

### Jazz projection — what `dev:jazz` wires up

`dev:jazz` is the one-command form of the three-process flow (verified end-to-end: a
real prompt streams over the WS, the backend projects the finalized user + assistant
messages into the standalone Jazz server, and they are queryable there):

```bash
# 1) standalone Jazz server (in-memory, app id fixed for dev, local-first auth on)
bun run dev:sync

# 2) backend: deploys schema+policies on boot, then projects finalized messages
JAZZ_SYNC=http://localhost:4200 \
  JAZZ_APP_ID=e0c77d7c-fc80-5775-8a1d-7f74d66410bf \
  JAZZ_BACKEND_SECRET=akko-dev-backend JAZZ_ADMIN_SECRET=akko-dev-admin \
  bun run dev:server

# 3) frontend: queries the Jazz messages table (opt-in)
VITE_JAZZ=1 bun run dev:web
# in the chat header, toggle "Live" <-> "Jazz"
```

## Test & check

```bash
bun test                # plumbing + SQLite + gateway + reducer + Jazz projection
AKKO_LIVE=1 bun test    # also runs the live prompt + live WS round-trip
```

The frontend uses **vitest** (not `bun:test`) for components + the runes store, since
`bun:test` can't render Svelte. Web tests use the `.vitest.ts` suffix (unit) and
`*.stories.svelte` (stories) so `bun test` ignores them and the two runners never collide:

```bash
bun --filter '@akko/web' test            # 32 jsdom unit tests (components + store)
bun --filter '@akko/web' test:storybook  # 12 story tests in a real browser (Playwright)
bun --filter '@akko/web' test:all        # both web vitest projects
bun --filter '@akko/web' storybook       # Storybook 10 — design components in isolation
bun --filter '@akko/web' build-storybook
# one-time for the browser tests: cd packages/web && bunx playwright install chromium
```

Typecheck & build:

```bash
bun run typecheck                    # tsc for @akko/core
bun --filter '@akko/web' check       # svelte-check (frontend types)
bun --filter '@akko/web' build       # vite production build of the web app
# per-package: ./node_modules/.bin/tsc --noEmit -p packages/<pkg>/tsconfig.json
```

## Layout

```
docs/architecture/   design + decision records (00–14)
packages/core/       domain model + interfaces (@akko/core)
packages/runtime/    concrete implementations (@akko/runtime)
packages/protocol/   shared WS/HTTP wire types (@akko/protocol)
packages/schema/     Jazz 2.0 relational schema (@akko/schema)
packages/server/     WebSocket + HTTP gateway + Jazz projector + dev entry (@akko/server)
packages/web/        Svelte 5 + bits-ui frontend (@akko/web)
```
