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

- **Two runners, by design:**
  - **Backend + pure logic: `bun test`** (Bun's built-in, `import ... from "bun:test"`).
    Native, fast, matches the Bun runtime decision (doc 11). Covers every backend package
    and the pure frontend conversation reducer.
  - **Frontend components + runes store: `vitest`** in `@akko/web`, split into two
    projects (`packages/web/vitest.config.ts`):
    - **`unit`** — jsdom + `@testing-library/svelte`, for components and the runes store.
    - **`storybook`** — real-browser tests via `@storybook/addon-vitest` (Playwright /
      chromium): every story's `play` function runs as a test.
  - **The two never collide:** `bun test` matches `*.test.ts` (including `*.svelte.test.ts`)
    but *ignores* `*.vitest.ts`. Web unit tests use the **`.vitest.ts`** suffix; story tests
    live in `*.stories.svelte`. So a plain root `bun test` runs only backend + reducer.
    Verified empirically.
- **Covered (bun test, 79 tests):** mailbox (ordering/authz/attribution), event bus,
  session-runtime entry capture, registry rehydration (durable/liveness split), SQLite
  adapter (incl. FTS5), SQLite conversation store durability, session index, membership
  store + `RoleBasedPolicy` (doc 16), gateway connection + real WS/HTTP (auth-stubbed),
  Jazz projector, **Jazz read-ACL** (workspace-claim JWT isolation) and the **standalone-
  server worker integration** (deploy + backend Db + projector round-trip), the frontend
  conversation reducer, and pi integration (construct-only always; live prompt + live WS
  round-trip under `AKKO_LIVE=1`).
- **Covered (vitest `unit`, 24 tests):** `MessageList`, `Composer`, `SessionList`,
  `ChatView` (title/messages/placeholder/menu/error + composer→`sendPrompt`),
  `JazzMessageList` (projected rows + empty, Jazz deps mocked), and the `AkkoClient`
  runes store (`loadSessions`/`createSession`/welcome-resubscribe/event-fold/`sendPrompt`/
  error) with mocked `fetch` + `WebSocket`.
- **Covered (vitest `storybook`, 11 browser tests):** every story renders + its `play`
  runs — `Composer`, `MessageList`, `SessionList`, `ChatView` (types + sends, error alert),
  `JazzMessageList` (projected + empty). Jazz is mocked via Vite aliases in
  `.storybook/main.ts` (`.storybook/mocks/`), so no live runtime/wasm is needed.
- **Storybook** (v10, `@storybook/svelte-vite`) for designing components in isolation.
  Stories (`*.stories.svelte`, native Svelte CSF) exist for all five components.
- **Gaps worth filling:**
  - `main.ts` (full-stack boot with a live model) is still covered only by manual/e2e
    probes. `jazz-worker.ts` is now covered by `jazz-worker.test.ts` (below).

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

bun test                # backend + reducer (bun:test); ignores *.vitest.ts
AKKO_LIVE=1 bun test    # + live pi prompt and live WS round-trip
# per-package typecheck: ./node_modules/.bin/tsc --noEmit -p packages/<pkg>/tsconfig.json
# frontend: cd packages/web && bun run check   (svelte-check) ; bun run build (vite)
#   web unit tests (vitest + jsdom):        bun --filter '@akko/web' test
#   story tests as browser tests (Playwright): bun --filter '@akko/web' test:storybook
#     (one-time: cd packages/web && bunx playwright install chromium)
#   design components in isolation (Storybook 10): bun --filter '@akko/web' storybook
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
1. ~~Verify the **browser read path live**~~ — **verified** (browser LocalFirstAuth +
   `QuerySubscription` renders projected rows; Live↔Jazz toggle works; Jazz view also
   shows history after reload). Remaining Jazz-view UX gap: it renders only *finalized*
   rows, so an in-flight turn gives no feedback (no optimistic user message, no spinner,
   no token stream) until both messages pop in at turn end. Auto-scroll is now fixed;
   the live-feedback gap is addressed by item 4.
2. ~~Replace the **dev-permissive row policy** with real **workspace read-ACL**~~ —
   **done** (doc 16): the `messages` table carries `workspaceId`, the row policy filters
   reads by the JWT's `workspaceId` claim, and the sync server verifies Better Auth JWTs
   via `--jwks-url` (no `--allow-local-first-auth`). Needs live end-to-end verification.
3. ~~A gated **standalone-server integration test** (server + backend + projector)~~ —
   **done** (`jazz-worker.test.ts`): drives the real `deployAkkoSchema` + `createBackendDb`
   + `JazzProjector` against an in-process standalone server, then reads the projected
   rows back through a workspace-member JWT (the deployed row policy). In-process
   (`startLocalJazzServer` + `startTestJwtIssuer`), so no external process/model — runs
   ungated in the default `bun test`. **The Jazz slice (A) is now closed.**

**B. Make rehydrated sessions render history**
4. ~~**Unify the read path**~~ — **done**. Canonical history now comes from SQLite via
   `GET /api/sessions/:id/history` (a cheap read, no model rehydration); the client seeds
   the reducer on select (once per session, never clobbering a live turn), and live
   streaming continues over the WS. Works in the default no-Jazz setup, so the Live view
   shows history after reload **and** an in-flight turn shows an optimistic "thinking"
   indicator that is **consistent across all subscribed tabs** (raised by the user message
   on the shared event stream, not just the optimistic sender). Jazz remains an optional read-model inspector. *Deferred:* multiplayer
   attribution rendering (the endpoint already returns `authorId`), and merging live
   streaming *into* the Jazz view (Jazz still shows finalized rows only).

**C. Core features not yet built**
5. **`ModelRouter`** (doc 05): ~~string resolver first~~ **slice 1 done** — `AkkoModelRouter`
   (`resolveModelString` delegating to pi's matcher + `catalog`), `GET /api/models`, a
   per-session model persisted on `SessionRef.model` (create with `model`, live change via
   the `setModel` command, re-applied on rehydration, broadcast cross-tab via a `session`
   patch), and a header model picker. **Next (slice 2):** the task classifier
   (`routeTask`, currently throws) — cheap Haiku-class call that picks a model per task.
6. **Subagents** (doc 03): `spawnSubagent` is a stub; implement as first-class registry
   sessions (in-process), reuse the agent-`.md` pattern.
7. **`SkillsService`** (doc 06): inventory + system-prompt token-impact view.

**D. Multiuser/auth**
8. ~~**Real auth**~~ — **in progress / v1 landed** ([doc 16](./16-auth.md)): Better Auth
   in-process (passkey + jwt plugins), tables in canonical SQLite; the gateway validates
   the session cookie on HTTP **and** at WS upgrade to derive `principalId` (retiring the
   trusted `?principal=` / `x-akko-principal`); `MembershipStore` + `RoleBasedPolicy`
   replace `AllowAllPolicy`. Passkey-only signup collects full name + email then mints the
   first passkey. *Deferred:* per-user
   workspaces, account recovery.
9. **Multiplayer rendering** — attribution per message, presence, mailbox/queue feedback.

**E. Testing/infra**
10. ~~**Frontend tests** via vitest + testing-library~~ — **done**. 24 jsdom unit tests
    (all five components + `AkkoClient`) and 11 Storybook browser tests via
    `@storybook/addon-vitest` (Playwright); Storybook 10 for isolated design. Jazz is
    mocked (`.storybook/mocks/`) so Jazz-coupled components render without a runtime.
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
- **Auth loose ends** (doc 16): the gateway has no CORS
  (dev is same-origin); no committed test yet for `/api/models` or the 403 non-member
  branches; the Jazz read-ACL (JWT claim + `--jwks-url` verification) typechecks and
  compiles but needs live end-to-end verification (3-process stack + browser passkey),
  plus JWT token refresh-on-expiry.