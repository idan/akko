# 14 — Jazz Evaluation and Integration

**We use `jazz-tools@2.0-alpha` (the version the Jazz docs target).** 2.0 is a
ground-up redesign: Jazz is now a **local-first relational database** (tables +
SQL-like queries + migrations + row policies + JWT auth), *not* the 0.x CoValue/CRDT
model. The `latest` npm tag is still `0.20.x` (CoValue), but that paradigm is being
retired, so we committed to the alpha.

The one gate from doc 11 (does Jazz's server run on Bun?) is retired: verified.

## What was verified (empirically, on Bun 1.3.14)

`jazz-tools@2.0.0-alpha.53`:

| Check | Result |
|-------|--------|
| Define schema (`s.table` / `s.defineApp`) + import | ✅ |
| Start a local server (`startLocalJazzServer({ inMemory: true })`) | ✅ (native server runs on Bun) |
| Backend context insert (`createJazzContext(...).asBackend(schema).insert(...)`) | ✅ |
| Query back (`db.all(app.messages.where({ sessionId }))`) | ✅ round-trips |
| Native builds required | WASM/native server; supported binary targets (macOS/Linux/Windows); no manual build |
| Frontend bundle | **~82 KB gzipped** (down from 433 KB on 0.20 — 2.0 drops prosemirror/tiptap) |

## What Jazz 2.0 is

A local-first **relational** database. You `s.defineApp({...})` a schema of `s.table`s
with typed columns, query with a SQL-like builder (`app.messages.where({...})`), and it
syncs local-first through a server (`jazz-tools server`) with row-level permission
policies and JWT/local-first auth. A backend connects via `createJazzContext(...)`; a
browser via `createJazzClient(...)` + `JazzSvelteProvider` + reactive `QuerySubscription`.

## How it maps onto Akko (CQRS preserved)

The golden rule (doc 04) holds: **Jazz is a projection of canonical SQLite, never the
source of truth; commands never flow through Jazz.**

```
frontend ──command (attributed, WS/HTTP)──▶ backend: mailbox → single writer → pi → SQLite (canonical)
                                                                   │
                                     backend JazzProjector inserts rows ▼
frontend ◀──── reactive query (QuerySubscription) ──── Jazz `messages` table (read model)
```

| Akko concept | Jazz 2.0 concept |
|--------------|------------------|
| Projected conversation (read model) | rows in a `messages` **table**, keyed by `sessionId` |
| Session list / metadata | rows in a `sessions` **table** (reactive across tabs/devices) |
| `Principal` attribution | a `authorId` column |
| Workspace read-ACL | row-level **policy**: `allowRead.where({ workspaceId: session.claims.workspaceId })` (doc 16) |
| Canonical conversation (source of truth) | **stays in SQLite** (doc 04) |
| Live token stream | ephemeral `activity` row (thinking + throttled streaming), retired to `idle` |
| Auth | Better Auth JWT verified via JWKS (doc 16) |

The relational model is a **cleaner fit than CoValues**: the `messages` table is a near
1:1 shape with our canonical SQLite, and "project" = "insert the same row into a synced
table."

## What changed vs. the 0.20 CoValue slice

- `@akko/schema`: `co.map`/`co.list` CoValues → `s.table` relational app.
- `@akko/server` `JazzProjector`: create Group + push to a CoList → **insert a row**
  via a backend `Db` (`createJazzContext(...).asBackend(schema)`). Per-session CoValue
  ids disappear; the key is just `sessionId`.
- Frontend: `CoState` on a CoValue → `QuerySubscription(() => app.messages.where(...))`;
  provider is `JazzSvelteProvider` + `createJazzClient` (external JWT from Better Auth;
  `LocalFirstAuth` was used during the evaluation and has been replaced).
- Deps: dropped `cojson`/`jazz-run`; the CLI is now `jazz-tools server`.

## Costs / risks

- **Alpha** — `2.0.0-alpha.x`, churning; expect breaking changes. Pin the exact version.
- New surface: **schema deploy/migrations, JWT auth, row policies** — more than CoValue
  sync, but conventional DB concepts.
- **Schema changes need a fresh sync server in dev.** The browser client publishes its
  local schema to the catalogue on connect (the `ObjectId` in a `CatalogueWriteDenied`
  warning is exactly the schema object id that `deploy()` publishes). Catalogue writes are
  admin-only, so an external-JWT browser client is **always** refused — this is a benign
  `WARN` when the schema is already deployed (the write is redundant), **not** a read
  failure. Redeploying a *changed* schema to an already-running in-memory server does not
  cleanly switch the catalogue (verified), so after any `@akko/schema` change fully
  restart `bun run dev:jazz`.
- **The projection must be rebuilt from canonical.** The Jazz store is disposable (the dev
  sync server is `--in-memory`, so every restart wipes it). `JazzProjector.rebuild()`
  backfills a session's messages from the `ConversationStore` on first sight
  (`ensureSession`), with deterministic per-entry row ids so it is idempotent. Without
  this, only messages sent *after* the projector saw the session are ever visible.
- **Row order is not insertion order.** Row ids are content-derived, so queries must
  `orderBy("createdAt")` explicitly (the UI does).
- **The browser client must use `driver: { type: "memory" }`.** Jazz's default is
  `persistent`, which in a browser means an OPFS store behind a **SharedWorker** that
  outlives page reloads *and* the dev sync server (which is `--in-memory`, so it is wiped
  on every restart). The result is a stale local database that never reconciles: queries
  succeed, return **0 rows, and report no error** — indistinguishable from "no data".
  Diagnosed with `bun run jazz:probe <sessionId> <jwt>`: reading the same server as the
  backend *and* as the user's own token both returned every row, proving the data and the
  row policy were fine and the fault was browser-local. Memory is also right on principle:
  the Jazz store is a **disposable projection** of SQLite (doc 04), so client-side
  persistence buys nothing and only creates staleness.
- Still the discipline rule: Jazz remains a *projection* of SQLite; the canonical
  conversation never lives only in a Jazz table.
- Upside banked: **much smaller bundle**, and a data model that matches ours.

## Status

**Migrated to 2.0-alpha and verified against a standalone server** (behind the existing
seams; the WS path is unchanged and Jazz is opt-in):

- `@akko/schema` — relational `messages`, `sessions` and `activity` tables + `defineApp`
  + workspace read-ACL `definePermissions` (doc 16); clients are read-only.
- `@akko/server` — `JazzProjector` projects finalized messages, session metadata and the
  ephemeral in-flight `activity` row via a backend `Db`, and **backfills** a session's
  history from canonical SQLite (`rebuild`); `createBackendDb` connects to the sync
  server; `deployAkkoSchema` publishes the schema + policies; `main.ts` deploys on boot
  and projects when `JAZZ_SYNC` + `JAZZ_APP_ID` + `JAZZ_BACKEND_SECRET`
  (+ `JAZZ_ADMIN_SECRET`) are set.
- `@akko/web` — `JazzSvelteProvider` (Better Auth JWT, memory driver) +
  `QuerySubscription`-backed message list, session list and chat header, gated behind
  `VITE_JAZZ=1`.
- **Verified live**: `jazz-tools server` runs on Bun; the backend deploys schema +
  policies on boot; a real agent turn flows through the full backend; and **two browser
  tabs render from the read model** — session list, in-flight thinking/streaming, and
  finalized messages all sync, with the workspace row-ACL enforced off the Better Auth
  JWT. 86 backend tests green; `svelte-check` + `vite build` pass (~82 KB gzipped).

Note: a fresh one-shot query on a cold context returns empty until local-first sync
completes; the browser reads reactively via `QuerySubscription`, which resolves as data
syncs. **Workspace read-ACL is wired and verified** (doc 16): every projected table carries a
`workspaceId`, the row policy filters reads by the JWT's `claims.workspaceId` (Better Auth
jwt plugin), and the sync server verifies those JWTs via `--jwks-url`. The worker path
(`deployAkkoSchema` + `createBackendDb` + `JazzProjector`) and the read-ACL are covered by
committed in-process integration tests (`jazz-worker.test.ts`, `jazz-read-acl.test.ts`).

## Debugging the read model

`bun run jazz:probe <sessionId> [jwt]` (`packages/server/scripts/jazz-probe.mjs`) reads a
running sync server twice — **as backend** (privileged, policy bypassed) and **as a user**
(external JWT, policy applied). That splits the space cleanly when the UI shows nothing:

| Probe result | Meaning |
|--------------|---------|
| backend 0 rows | the projector's writes never reached the server |
| backend rows, user 0 rows | the row policy is filtering server-side |
| both have rows | browser-side (driver/worker staleness, or the component) |

The raw JWT is logged by the frontend under `VITE_JAZZ_DEBUG=1`; the projector logs its
writes under `AKKO_JAZZ_DEBUG=1`.

**Testing rule learned the hard way:** a projection test that reads back through the
**same `Db` that wrote the row proves nothing** — local-first clients always see their own
writes, even when the row never reaches the server or is refused by policy. Two real bugs
(the delete tombstone and the missing backfill) hid behind exactly that shape. Projection
tests must read from a **separate client**, and lifecycle bugs need a **multi-turn**
scenario.

Next: migrate the default frontend read path to Jazz (unify step 2, doc 15) and token
refresh-on-expiry.