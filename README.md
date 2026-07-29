# Akko

An opinionated, minimalistic personal agentic system built on top of the
[pi](https://pi.dev) coding agent, with a first-party responsive web frontend
(Svelte 5 + bits-ui + Tailwind) and multiuser/multiplayer-capable design.

- **Runtime:** Bun (see [`docs/architecture/11-runtime-evaluation.md`](docs/architecture/11-runtime-evaluation.md)).
  Deno is a verified fallback; the only runtime-coupled seam is the SQLite driver
  behind `ConversationStore` (`packages/core/src/sqlite.ts`).
- **Design docs:** [`docs/architecture/`](docs/architecture/README.md) — read the
  index first. **Resuming work?** Start at
  [15 — Status and Roadmap](docs/architecture/15-status-and-roadmap.md).
- **Core interfaces (design skeleton):** [`packages/core/src`](packages/core/src),
  documented in [`docs/architecture/10-core-interfaces.md`](docs/architecture/10-core-interfaces.md).

## Status

Early implementation, but end-to-end usable. `packages/core` holds the interfaces (the
compilable shape of the system, multiuser-by-construction). `packages/runtime` implements
them: id generation, an in-memory event bus, the per-session mailbox (actor model), a
session runtime + registry that drive pi via `createAgentSession`, SQLite-canonical
conversation storage, a session index, and a workspace membership store.

You can **sign up with a passkey, chat with a real agent, and watch it stream** — with the
session list, in-flight state and message history rendering from a synced read model that
stays live across tabs and devices.

The agent can also **delegate**: `spawn_subagent` takes a list of independent tasks and
runs them as parallel child sessions, each with its own fresh context window, so broad
work ("summarize every doc in this project") doesn't flood the conversation. Subagents are
ordinary sessions (doc 03) — same registry, mailbox and authorization — so they persist,
project and rehydrate like anything else. Concurrency is capped
(`AKKO_SUBAGENT_MAX_PER_PARENT`, default 3) and they cannot nest.

**Verified end-to-end on Bun** (`bun test`): 86 tests green across `@akko/runtime`,
`@akko/server`, and `@akko/web` (backend + pure reducer), including SQLite (FTS5)
durability + rehydration, a canonical history endpoint, model routing (string resolver +
catalog), passkey-auth plumbing (membership store + role policy), the Jazz projection
(history backfill, session metadata, live streaming) and its workspace read-ACL, a live pi
prompt end-to-end over HTTP (`AKKO_LIVE=1`). The Svelte frontend adds
**34 jsdom unit tests** (via vitest + `@testing-library/svelte`) and **12 Storybook browser
tests** (each story's `play` run under Playwright via `@storybook/addon-vitest`), plus
**Storybook 10** for designing components in isolation. The web app type-checks
(`svelte-check`) and builds (`vite build`). See the implementation order in doc 10.

## Run it

One command brings up the whole dev stack — sync server, gateway and web app:

```bash
bun install
bun run dev        # sync (:4200) + server (:8787) + web (:5173) — all 3 processes
# open http://localhost:5173
```

Jazz is the **only** read model (doc 15), so the sync server is not optional: without it
the app has nothing to render and shows a retrying "read model unavailable" screen.

`dev` uses `concurrently` and a small `scripts/wait-port.mjs` gate so the backend
waits for the standalone Jazz server to be listening before it deploys its schema. The
individual processes are still available if you want separate terminals:
`bun run dev:sync`, `bun run dev:server`, `bun run dev:web`.

> The gateway runs under `bun --watch`, so backend source edits restart it automatically
> (a restart drops liveness only — sessions rehydrate from SQLite on next use, per doc 03).
> An in-flight turn *is* lost, so avoid editing mid-turn.
>
> **After any `@akko/schema` change, fully restart `bun run dev`** (Ctrl-C, rerun). The
> in-memory sync server keeps its old schema catalogue and `dev:server` doesn't
> auto-restart (doc 14). Note the Jazz store is disposable: a restart wipes all projected
> rows, and the projector **backfills** a session's history from canonical SQLite when it
> first sees the session. A `CatalogueWriteDenied` warning in the browser console is
> expected and benign (the browser can't write the admin-owned schema catalogue).

Design components in isolation (optional, separate dev server):

```bash
bun --filter '@akko/web' storybook   # Storybook 10 on :6006
```

### Why does Jazz run as a separate process?

Jazz is **not the source of truth** — SQLite is (doc 04). It is a *disposable projection*
of canonical state: the backend projects the session list, finalized messages and the
in-flight turn (thinking + streaming text) into relational tables the browser queries
reactively. Wipe the Jazz store and the projector rebuilds it from SQLite.

It is, however, the **only read model** (doc 15). The WebSocket, the client-side event
reducer and the second render path are gone; the browser POSTs commands over HTTP and
observes every effect through Jazz, which is what gives cross-tab/device/member sync for
free. So the sync server is a hard dependency of the frontend, and both sides are wired
by `bun run dev`:

- **Backend** enables the projector when `JAZZ_SYNC` + `JAZZ_APP_ID` +
  `JAZZ_BACKEND_SECRET` are set (otherwise it logs `jazz: disabled` and projects nothing).
- **Frontend** fetches a Better Auth JWT, creates the Jazz client, and wraps the app in
  `JazzSvelteProvider`. If the sync server is unreachable it shows a retrying
  "read model unavailable" screen rather than a blank app.

Worth knowing: `jazz-tools` is still `2.0.0-alpha` (pinned, expect breaking changes), and
doc 15 lists the alpha gotchas that cost real debugging time — delete-is-a-tombstone, the
browser needing `driver: memory`, and the benign `CatalogueWriteDenied` warning.

## Test & check

```bash
bun test                # plumbing + SQLite + gateway + reducer + Jazz projection
AKKO_LIVE=1 bun test    # also runs the live prompt + live WS round-trip
```

The frontend uses **vitest** (not `bun:test`) for components + the runes store, since
`bun:test` can't render Svelte. Web tests use the `.vitest.ts` suffix (unit) and
`*.stories.svelte` (stories) so `bun test` ignores them and the two runners never collide:

```bash
bun --filter '@akko/web' test            # 34 jsdom unit tests (components + store)
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
packages/web/        Svelte 5 + bits-ui + Tailwind v4 frontend (@akko/web)
```
