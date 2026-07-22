# 15 — Status and Roadmap

**Read this first when resuming.** It is the single source of truth for where the
project is, what is proven, how to run it, and what to do next. The numbered docs
00–14 hold the *why* behind each decision; this doc holds the *state* and the *plan*.

_Last updated: after wiring the Jazz projection to a standalone `jazz-tools server`._

## Current state (what works end-to-end)

A browser can talk to the backend and drive a real agent, and the conversation is
projected into a synced database:

```
browser (Svelte 5 + bits-ui)
  ── HTTP: create/list sessions ─────────────▶ gateway
  ── WS:  attributed command (prompt) ───────▶ mailbox → SessionRuntime → pi (Anthropic default)
  ◀─ WS:  streaming events (text/tool/lifecycle)
                                               │ committed entries →
                                               ├─▶ SQLite (canonical, doc 04)  ── lazy rehydration
                                               └─▶ JazzProjector → standalone jazz-tools server (read-model, opt-in)
```

Verified on Bun: live prompt over the WS returns streamed assistant text; SQLite
persistence + lazy rehydration; and a **real agent turn projected into a standalone
Jazz server as queryable rows** (doc 14).

## Package status

| Package | What | State |
|---------|------|-------|
| `@akko/core` | domain model + interfaces (seams only) | interfaces only, by design |
| `@akko/protocol` | shared WS/HTTP wire types | done |
| `@akko/runtime` | ids, event bus, mailbox, session runtime + registry (drives pi), SQLite adapter + conversation store + session index | done, tested |
| `@akko/server` | Bun.serve WS+HTTP gateway (CQRS) + Jazz projector/worker + dev entry | done, tested |
| `@akko/schema` | Jazz 2.0 relational `messages` table + row policy | done |
| `@akko/web` | Svelte 5 + bits-ui frontend: session list, live chat, composer, Jazz view toggle | first slice done |

## Tests

- **Runner: `bun test` (Bun's built-in, `import ... from "bun:test"`), not vitest.**
  This is deliberate for the backend (native, fast, matches the Bun runtime decision,
  doc 11).
- **Covered:** mailbox (ordering/authz/attribution), event bus, session-runtime entry
  capture, registry rehydration (durable/liveness split), SQLite adapter (incl. FTS5),
  SQLite conversation store durability, session index, gateway connection + real WS/HTTP,
  Jazz projector (in-memory server round-trip), the frontend conversation reducer, and
  pi integration (construct-only always; live prompt + live WS round-trip under
  `AKKO_LIVE=1`). 50 tests.
- **Gaps worth filling:**
  - **Frontend components + the `client.svelte.ts` runes store have no tests** — only
    the pure reducer is tested. This is the clearest gap. Recommendation: add **vitest +
    `@testing-library/svelte`** for the web package specifically (the Svelte ecosystem
    standardizes on vitest; `bun:test` can't render components). Keep `bun:test` for the
    backend packages.
  - `jazz-worker.ts` and `main.ts` are covered only by manual/e2e probes, not committed
    tests (they need a running server + model). A gated integration test could cover the
    standalone-server path.

## How to run / test

```bash
bun install
bun run dev:server      # gateway :8787 + dev workspace (wsp_dev)
bun run dev:web         # Vite :5173 (proxies /api + /ws)

# with the Jazz projection (3 processes — see README):
bun run dev:sync        # standalone jazz-tools server :4200
JAZZ_SYNC=http://localhost:4200 JAZZ_APP_ID=e0c77d7c-fc80-5775-8a1d-7f74d66410bf \
  JAZZ_BACKEND_SECRET=akko-dev-backend JAZZ_ADMIN_SECRET=akko-dev-admin bun run dev:server
VITE_JAZZ=1 bun run dev:web

bun test                # all packages
AKKO_LIVE=1 bun test    # + live pi prompt and live WS round-trip
# per-package typecheck: ./node_modules/.bin/tsc --noEmit -p packages/<pkg>/tsconfig.json
# frontend: cd packages/web && bun run check   (svelte-check) ; bun run build (vite)
```

## Decisions & where they live (accumulated knowledge)

| Topic | Doc |
|-------|-----|
| Vision, goals, principles | 00 |
| pi as foundation; what pi persists; pi's file writer is unusable for us | 01, 04 |
| Multiuser tenancy, identity, ID format (prefixed nanoid) | 02 |
| Durable/liveness split, per-session mailbox (actor model), subagents-as-sessions | 03 |
| Storage: single-writer, SQLite-canonical, Projector seam | 04 |
| Model routing (string vs task) — **not built yet** | 05 |
| Skills + system-prompt impact — **not built yet** | 06 |
| Memory — deferred; seam only | 07 |
| Frontend/realtime CQRS, presence (design) | 08 |
| Security; pi has no sandbox; isolation seam | 09 |
| Core interfaces map | 10 |
| Runtime: **Bun** (Deno viable); empirical | 11 |
| Distributed execution (daemons, node↔Hub) — **design only** | 12 |
| Database: SQLite now; SearchIndex seam for vectors | 13 |
| Jazz 2.0 (relational) evaluation + integration + standalone server | 14 |

## Next steps (prioritized)

**A. Close out the Jazz slice**
1. Verify the **browser read path live** (LocalFirstAuth + `QuerySubscription` against
   the standalone server) — the one piece not verifiable from Bun probes (doc 14).
2. Replace the **dev-permissive row policy** with real **workspace read-ACL**
   (`definePermissions` mapping Workspace→policy, doc 02/14).
3. A gated **standalone-server integration test** (server + backend + projector).

**B. Make rehydrated sessions render history**
4. **Backlog/history fetch** — the WS view renders live events only; a rehydrated
   session shows no past messages. Either add a `get_entries`-style endpoint + seed the
   reducer, or make Jazz the default read path (it already holds finalized messages).

**C. Core features not yet built**
5. **`ModelRouter`** (doc 05): string resolver first, then the task classifier. Today
   every session uses the pi default (`anthropic/claude-opus-4-8`).
6. **Subagents** (doc 03): `spawnSubagent` is a stub; implement as first-class registry
   sessions (in-process), reuse the agent-`.md` pattern.
7. **`SkillsService`** (doc 06): inventory + system-prompt token-impact view.

**D. Multiuser/auth**
8. **Real auth** — replace hardcoded `prn_dev`/`wsp_dev`; wire `authorize()` beyond
   `AllowAllPolicy`; consider Jazz JWT / Better Auth.
9. **Multiplayer rendering** — attribution per message, presence, mailbox/queue feedback.

**E. Testing/infra**
10. **Frontend tests** via vitest + testing-library (see Tests gap above).
11. Consider migrating the `ConversationStore` from linear messages to full
    tree/branch/compaction fidelity when needed (doc 04, route 3).

**F. Later (design done, not built)**
12. Memory + `SearchIndex` (doc 07/13); container isolation (doc 09); distributed
    execution — daemon + node↔Hub link + replication (doc 12).

## Known gaps & caveats

- **Local-first read latency:** a fresh one-shot Jazz query returns empty until sync
  completes; the browser reads reactively via `QuerySubscription` (doc 14).
- **jazz-tools is alpha** (`2.0.0-alpha.x`) — pinned; expect breaking changes on bumps.
- **ConversationStore** persists linear conversation only (no branch/compaction yet).
- **Inference** is the global pi default; no per-tenant credentials or routing yet.
- The **write tool used during development** intermittently appends stray
  `</content>`/`</invoke>` tags to files; strip + re-verify after batch writes.