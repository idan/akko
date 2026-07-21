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
| `Principal` attribution | a `authorId` column |
| Workspace read-ACL (future) | row-level **policies** |
| Canonical conversation (source of truth) | **stays in SQLite** (doc 04) |
| Live token stream | stays on the **WS** (only finalized messages are projected) |
| Deferred auth | JWT / `LocalFirstAuth` |

The relational model is a **cleaner fit than CoValues**: the `messages` table is a near
1:1 shape with our canonical SQLite, and "project" = "insert the same row into a synced
table."

## What changed vs. the 0.20 CoValue slice

- `@akko/schema`: `co.map`/`co.list` CoValues → `s.table` relational app.
- `@akko/server` `JazzProjector`: create Group + push to a CoList → **insert a row**
  via a backend `Db` (`createJazzContext(...).asBackend(schema)`). Per-session CoValue
  ids disappear; the key is just `sessionId`.
- Frontend: `CoState` on a CoValue → `QuerySubscription(() => app.messages.where(...))`;
  provider is `JazzSvelteProvider` + `createJazzClient` + `LocalFirstAuth`.
- Deps: dropped `cojson`/`jazz-run`; the CLI is now `jazz-tools server`.

## Costs / risks

- **Alpha** — `2.0.0-alpha.x`, churning; expect breaking changes. Pin the exact version.
- New surface: **schema deploy/migrations, JWT auth, row policies** — more than CoValue
  sync, but conventional DB concepts.
- Still the discipline rule: Jazz remains a *projection* of SQLite; the canonical
  conversation never lives only in a Jazz table.
- Upside banked: **much smaller bundle**, and a data model that matches ours.

## Status

**Migrated to 2.0-alpha and verified against a standalone server** (behind the existing
seams; the WS path is unchanged and Jazz is opt-in):

- `@akko/schema` — relational `messages` table + `defineApp` + a dev read/insert
  **row policy** (`definePermissions`) so a local-first client can read.
- `@akko/server` — `JazzProjector` inserts finalized messages via a backend `Db`;
  `createBackendDb` connects to the sync server; `deployAkkoSchema` publishes the
  schema + policies; `main.ts` deploys on boot and projects when `JAZZ_SYNC` +
  `JAZZ_APP_ID` + `JAZZ_BACKEND_SECRET` (+ `JAZZ_ADMIN_SECRET`) are set.
- `@akko/web` — `JazzSvelteProvider` (local-first auth) + a `QuerySubscription`-backed
  message view, gated behind `VITE_JAZZ=1`, toggled against the live WS view.
- **Standalone-server e2e verified on Bun**: `jazz-tools server` runs; the backend
  deploys schema + policies to it on boot; a **real agent turn** flows through the full
  backend and the projector writes the finalized user + assistant messages as rows in
  the standalone server, where they are queryable. In-process test
  (`jazz-projector.test.ts`) covers the projector against an in-memory server; 50 tests
  green; `svelte-check` + `vite build` pass (~82 KB gzipped).

Note: a fresh one-shot query on a cold context returns empty until local-first sync
completes; the browser reads reactively via `QuerySubscription`, which resolves as data
syncs. Next: verify the browser read path live, add real workspace read-ACL policies
(replacing the dev-permissive one), migrate the default frontend read path to Jazz, and
JWT auth.