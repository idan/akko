# Akko

An opinionated, minimalistic personal agentic system built on top of the
[pi](https://pi.dev) coding agent, with a first-party responsive web frontend
(Svelte 5 + bits-ui) and multiuser/multiplayer-capable design.

- **Runtime:** Bun (see [`docs/architecture/11-runtime-evaluation.md`](docs/architecture/11-runtime-evaluation.md)).
  Deno is a verified fallback; the only runtime-coupled seam is the SQLite driver
  behind `ConversationStore` (`packages/core/src/sqlite.ts`).
- **Design docs:** [`docs/architecture/`](docs/architecture/README.md) — read the
  index first.
- **Core interfaces (design skeleton):** [`packages/core/src`](packages/core/src),
  documented in [`docs/architecture/10-core-interfaces.md`](docs/architecture/10-core-interfaces.md).

## Status

Early implementation. `packages/core` holds the interfaces (the compilable shape of
the system, single-user today and multiuser-by-construction). `packages/runtime` has
the first working slice: id generation, an in-memory event bus, the per-session
mailbox (actor model), a session runtime + registry that drive pi via
`createAgentSession`, an in-memory conversation store, and a host workspace-runtime
factory.

**Verified end-to-end on Bun** (`bun test`): 48 tests green across `@akko/runtime`,
`@akko/server`, and `@akko/web`, including SQLite (FTS5) durability + rehydration, a
live pi prompt, a **live WebSocket round-trip** (`AKKO_LIVE=1`), and the frontend
conversation reducer. The Svelte 5 + bits-ui web app type-checks (`svelte-check`) and
builds (`vite build`). See the implementation order in doc 10.

## Run it

```bash
bun install
bun run dev:server     # boots the gateway on :8787 with a dev workspace (wsp_dev)
bun run dev:web        # Vite dev server on :5173, proxying /api + /ws to the gateway
# open http://localhost:5173
```

Optional — enable the Jazz projection (doc 14, `jazz-tools@2.0-alpha` relational DB):

```bash
bun run dev:sync                          # local Jazz server (jazz-tools server)
# note its app id + backend secret, then:
JAZZ_SYNC=<server url> JAZZ_APP_ID=<app id> JAZZ_BACKEND_SECRET=<secret> \
  bun run dev:server                      # projector inserts finalized messages
VITE_JAZZ=1 bun run dev:web               # frontend queries the Jazz messages table
# in the chat header, toggle "Live" <-> "Jazz"
```

```bash
bun test                # plumbing + SQLite + gateway + reducer + Jazz projection
AKKO_LIVE=1 bun test    # also runs the live prompt + live WS round-trip
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
