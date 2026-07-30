# 15 — Status and Roadmap

**Read this first when resuming.** It is the single source of truth for where the
project is, what is proven, how to run it, and what to do next. The numbered docs
00–16 hold the *why* behind each decision; this doc holds the *state* and the *plan*.

_Last updated: after **the unify plan completed through step 3** — commands go over HTTP,
the WebSocket is gone, and Jazz is the sole read model._

## ▶ Pick up here

**Unify steps 1–3 are done.** The WebSocket, the client-side conversation reducer and the
per-socket event fan-out are deleted (~800 lines): the browser POSTs commands to
`/api/sessions/:id/commands` and observes every effect through Jazz. All three gating
measurements passed — write amplification is bounded (~24 writes/s while streaming), two
tabs on one session stay in sync, and **reconnect converges** after going offline mid-turn.

Recently closed: **Jazz token refresh** (an expired JWT used to mean a frozen UI, since
step 3 removed the fallback read path) and **session rename** (the `rename` verb now has
a handler plus inline editing in the list).

**Next action: unify step 4** — presence/typing + per-message attribution, now cheap
because everything is already a Jazz table (see the plan below). Or pick from
[C. Core features](#c-core-features-not-yet-built): **subagents** (`spawnSubagent` is
still a stub) is the biggest capability gain, then the **task classifier** for
`ModelRouter`, then `SkillsService`.

**Note:** the read model is disposable and the dev sync server is in-memory, so after any
restart a session has a metadata row but **no messages** until something asks for them.
Opening a session POSTs `/api/sessions/:id/projection`, which backfills its history from
canonical SQLite without rehydrating pi. (Before that endpoint existed, an existing
session rendered empty until you sent it a message.)

**Note:** Jazz is no longer optional. There is no `VITE_JAZZ` flag and no non-Jazz dev
mode — `bun run dev` starts the sync server, gateway and web app together, and the app
shows a retrying "read model unavailable" screen if the sync server is missing.

## Current state (what works end-to-end)

A browser authenticates with a passkey, drives a real agent, and renders from a synced
read model that is live across tabs, devices and workspace members:

```
browser (Svelte 5 + bits-ui)
  ── passkey sign-in ──▶ Better Auth (in-process, doc 16) ──▶ session cookie
  ── HTTP: create/list sessions ($cookie) ────────▶ gateway
  ── HTTP: attributed command (prompt) ──────────▶ mailbox → authorize() → SessionRuntime → pi
     (no socket: every effect comes back through the Jazz read model)
                                               │ committed entries →
                                               ├─▶ SQLite (canonical, doc 04) ── lazy rehydration
                                               └─▶ JazzProjector ──▶ jazz-tools server
                                                     • messages  (finalized, backfilled)
                                                     • activity  (thinking + streaming)
                                                     • sessions  (reactive session list)
  ◀─ Jazz (JWT, workspace row-ACL): reactive queries render the above
```

Verified live: passkey signup/sign-in, a real agent turn streaming over the WS, SQLite
persistence + lazy rehydration, and the **Jazz read model driving the UI across two
tabs** — session list, in-flight thinking/streaming, and finalized messages all sync
without socket fan-out.

## Package status

| Package | What | State |
|---------|------|-------|
| `@akko/core` | domain model + interfaces (seams only) + `RoleBasedPolicy` | interfaces only, by design |
| `@akko/protocol` | shared WS/HTTP wire types | done |
| `@akko/runtime` | ids, event bus, mailbox, session runtime + registry (drives pi), SQLite adapter + conversation store + session index + membership store | done, tested |
| `@akko/server` | Bun.serve WS+HTTP gateway (CQRS) + Better Auth (passkeys) + Jazz projector/worker + dev entry | done, tested |
| `@akko/schema` | Jazz 2.0 relational `messages` / `activity` / `sessions` tables + workspace read-ACL | done |
| `@akko/web` | Svelte 5 + bits-ui frontend: passkey auth, session list, live chat, composer, Jazz read model | done for the current slice |

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
- **Covered (bun test, 86 tests):** mailbox (ordering/authz/attribution), event bus,
  session-runtime entry capture (incl. **monotonic entry timestamps**, which read models
  order by), registry rehydration (durable/liveness split), **registry boot projection**,
  SQLite adapter (incl. FTS5), SQLite conversation store durability, session index,
  membership store + `RoleBasedPolicy` (doc 16), gateway connection + real WS/HTTP
  (auth-stubbed), Jazz projector (**history backfill, session metadata, live
  thinking/streaming, and the two-turn regression**), **Jazz read-ACL** (workspace-claim
  JWT isolation) and the **standalone-server worker integration** (deploy + backend Db +
  projector round-trip, read back by a *separate* JWT client), the frontend conversation
  reducer, and pi integration (construct-only always; live prompt + live WS round-trip
  under `AKKO_LIVE=1`).
- **Covered (vitest `unit`, 34 tests):** `MessageList`, `Composer`, `SessionList`
  (presentational: data props in, callbacks out), `ChatView`
  (title/messages/placeholder/menu/error + composer→`sendPrompt`), `JazzMessageList`
  (projected rows, empty, streaming bubble, thinking indicator — Jazz deps mocked), and
  the `AkkoClient` runes store (`loadSessions`/`createSession`/welcome-resubscribe/
  event-fold/`sendPrompt`/error) with mocked `fetch` + `WebSocket`.
- **Covered (vitest `storybook`, 12 browser tests):** every story renders + its `play`
  runs — `Composer`, `MessageList`, `SessionList`, `ChatView` (types + sends, error alert),
  `JazzMessageList` (projected + empty). Jazz is mocked via Vite aliases in
  `.storybook/main.ts` (`.storybook/mocks/`), so no live runtime/wasm is needed.
- **Storybook** (v10, `@storybook/svelte-vite`) for designing components in isolation.
  Stories (`*.stories.svelte`, native Svelte CSF) exist for the five core components.
- **A hard-won testing rule (doc 14):** a projection test that reads back through the
  **same `Db` that wrote it proves nothing** — local-first clients always see their own
  writes, even when the row never reaches the server or is rejected by policy. Two real
  bugs hid behind exactly that shape. Projection tests must read from a **separate
  client**, and lifecycle bugs need a **multi-turn** scenario.
- **Gaps worth filling:**
  - `main.ts` (full-stack boot with a live model) is still covered only by manual/e2e
    probes. `jazz-worker.ts` is covered by `jazz-worker.test.ts`.

## How to run / test

```bash
bun install
bun run dev             # server (:8787) + web (:5173), no Jazz
bun run dev             # sync (:4200) + server (:8787) + web (:5173) — the whole stack

# NOTE: after ANY @akko/schema change you must fully restart `bun run dev` — the in-memory
# sync server keeps its old schema catalogue and dev:server does not auto-restart (doc 14).

# verbose diagnostics (fish: prefix inline, no `env` needed)
AKKO_JAZZ_DEBUG=1 VITE_JAZZ_DEBUG=1 bun run dev

# inspect what is actually stored in a running sync server (doc 14):
bun run jazz:probe <sessionId> [jwt]   # reads AS BACKEND (policy bypassed) and AS USER

# dev data helpers (doc 16):
bun run db:reset                 # wipe the whole SQLite db (users + conversations)
bun run db:delete-user <email>   # remove one user (passkey/session/account/memberships)

bun test                # backend + reducer (bun:test); ignores *.vitest.ts
AKKO_LIVE=1 bun test    # + live pi prompt and live WS round-trip
# per-package typecheck: bun x tsc --noEmit -p packages/<pkg>/tsconfig.json
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
| Model routing (string vs task) — string resolver **done**, classifier not built | 05 |
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
1. ~~Verify the **browser read path live**~~ — **verified**; the Jazz view renders
   finalized rows **plus** live feedback now (see item 4): an ephemeral `activity` row
   drives a "thinking" indicator and a progressively-**streaming** assistant bubble,
   projected from the same pi event stream the WS consumes. Auto-scroll fixed.
2. ~~Replace the **dev-permissive row policy** with real **workspace read-ACL**~~ —
   **done and verified live** (doc 16): every projected table carries `workspaceId`, the
   row policy filters reads by the JWT's `workspaceId` claim, and the sync server verifies
   Better Auth JWTs via `--jwks-url`.
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
   on the shared event stream, not just the optimistic sender). *Deferred:* multiplayer
   attribution rendering (the endpoint already returns `authorId`). **The Jazz view now
   shows live streaming too** — an ephemeral `activity` table (thinking + throttled
   streaming text) projected from the pi event stream, deleted when the finalized message
   lands (`jazz-projector.ts`). This is phases 1–2 of the "make Jazz the sole read model"
   plan. **Phase-3 finding (measured):** Jazz's local-first sync is **eventually
   consistent and coalesces rapid updates** — transient states (a brief "thinking" before
   streaming) are often swallowed before they become queryable, streaming text arrives in
   coalesced jumps rather than smoothly, and there's propagation lag vs. the WS. That
   measurement was taken *before* the four Jazz bugs below were found; with them fixed and
   `STREAM_FLUSH_MS` at 40ms the streaming was judged **good enough in live use**, so the
   coalescing is a tuning concern rather than a blocker. Defensive logging added
   (`AKKO_JAZZ_DEBUG=1` backend, `VITE_JAZZ_DEBUG=1` frontend); the event bus now isolates
   listener failures so a projector error can't break WS delivery. *Deferred:* user-typing
   presence, crash-staleness of the ephemeral row.

### A2. Making Jazz the sole read model (the unify plan)

Decided after the phase-3 measurement: go **all-in on Jazz for reads** rather than a
hybrid. The hybrid (sockets for streaming, Jazz for settled state) was rejected because it
keeps two rendering paths *and* loses the multiplayer property — with WS streaming only
subscribed clients see the in-flight text, whereas the `activity` row gives every observer
(other tabs, devices, members) the same in-flight state with no fan-out code. Straddling
two read paths also *caused* two real bugs (see below), which is the strongest argument
against staying in the middle.

The destination is **HTTP for commands + Jazz for all reads** — no WebSocket at all,
retiring ~800 lines of read-path machinery (`conversation.ts`, `client.svelte.ts`,
`connection.ts` and their tests).

1. ~~**Project session metadata** → reactive session list~~ — **done + verified live
   across two tabs.** New `sessions` table; `registerWorkspace` projects metadata for
   every session in the durable index at boot (so the list is complete, not just sessions
   this process touched); `setModel` re-projects the ref. `SessionList` is now
   presentational, fed by `JazzSessionList` (a `QuerySubscription` *inside* the provider)
   or the WS client.
2. ~~**Make Jazz the default read path**, drop the Live/Jazz toggle~~ — **done.** With a
   Jazz provider mounted, `JazzMessageList` *is* the message view (no toggle, no
   "projected read model" banner); the WS reducer view remains the fallback for the
   no-Jazz setup (`bun run dev`), so the socket is still a free safety net. Also folded
   in: `SessionIndex.touch()` now runs as an entry sink (`createSessionTouchSink`), so
   `updatedAt` tracks real activity and the reactive list orders by recency; and the
   vestigial per-session `jazzId` plumbing was dropped from the client (the read model is
   queried by `sessionId`). *Still deferred:* session **rename** — the `rename` verb
   exists in `CommandVerb` but has no implementation or UI; it is a write feature, not a
   read-path concern.
3. ~~**Move commands to HTTP**, delete the WS + reducer + event folding~~ — **done.**
   `POST /api/sessions/:id/commands` is the entire write path; the actor is derived from
   the session cookie server-side. Deleted: `connection.ts` (per-socket fan-out),
   `conversation.ts` (the event reducer), `MessageList.svelte` (the second render path),
   the `ClientMessage`/`ServerMessage` wire types, the `/ws` route and the Vite WS proxy —
   ~800 lines net. `AkkoClient` is now write-only. The vestigial `jazzId`/`projectionId()`
   went with it. **Gate results:** write amplification bounded (~24 writes/s, capped by
   the 40ms flush regardless of token rate); two tabs sync flawlessly; reconnect after a
   mid-turn offline period converges. Throttling via DevTools proved to be a non-test —
   it does not apply to WebSocket traffic or to loopback, so the offline/reconnect test
   is what actually cleared this step.
4. **Presence/typing + per-message attribution** — cheap once everything is a Jazz table
   (the history endpoint already returns `authorId`).

**Risk being managed:** jazz-tools is alpha, and this session alone surfaced four
non-obvious behaviours (below). Making Jazz load-bearing for everything means an alpha
regression takes down the whole UI, so the WS is retired **last** and the `Projector` seam
(doc 04) is kept so a fallback is a config flip, not a rewrite.

### C. Core features not yet built
5. **`ModelRouter`** (doc 05): ~~string resolver first~~ **slice 1 done** — `AkkoModelRouter`
   (`resolveModelString` delegating to pi's matcher + `catalog`), `GET /api/models`, a
   per-session model persisted on `SessionRef.model` (create with `model`, live change via
   the `setModel` command, re-applied on rehydration, broadcast cross-tab via a `session`
   patch), and a header model picker. **Next (slice 2):** the task classifier
   (`routeTask`, currently throws) — cheap Haiku-class call that picks a model per task.
6. **Subagents** (doc 03): ~~`spawnSubagent` is a stub~~ — **slice 1 done.** Real
   `spawnSubagent()` creating `kind: "subagent"` sessions with a `parentSessionId`, plus a
   blocking `spawn_subagent` pi tool so the *model* can delegate. Design decisions:
   **blocking** (one tool call in, one answer out — async/fleet is a later change to who
   delivers the result, not to the model); attribution to the **initiating human** rather
   than a service principal, so membership + role checks apply unchanged; nesting prevented
   by **withholding the tool** from children rather than by a counter. Caps never queue
   *across* sessions — a cross-session queue plus blocking spawns is a resource deadlock
   the moment depth > 1 — but within one batch a unit waits (bounded) for its own slot,
   which is safe because subagents cannot spawn, so every slot holder is doing work that
   finishes. Subagents are filtered
   out of the session list (data is all there — doc 15 C8 if we later render them nested).
   `spawn_subagent` takes a **list** of tasks and runs them in parallel: three rounds of
   prompt-tuning failed to make a model reliably issue N separate calls (it enumerated
   correctly, then reasoned itself into one "handle all of them at once" call), so the
   parallel path is now the *easy* path rather than the disciplined one. **Measured:** one
   call with 19 tasks produced 19 children, 123s of child work in 43.6s wall clock — a
   2.8x speedup, essentially the theoretical maximum for the default cap of 3.
   **Slice 2 (in progress):** ~~live progress~~ **done** — the tool publishes
   `{ type: "progress" }` on the event bus and the projector folds it into the parent's
   activity row ("19 subagents — 7/19 done"); ~~per-provider caps~~ **done** —
   `AKKO_SUBAGENT_MAX_PER_PROVIDER=ollama=2`, applied across all sessions since the
   constraint is shared hardware; ~~agent-type `.md` presets~~ **done** — `.akko/agents/*.md`
   parsed with pi's `parseFrontmatter`, configuring model/thinkingLevel/**tool allowlist**
   plus instructions, advertised in the tool description; ~~`stopSubagent`~~ **done** —
   scoped to the caller's own children. **Slice 2 complete.** Possible later work:
   async/fleet spawning (the blocking design was chosen to make this a change of *who
   delivers the result*, not of the model), and rendering subagents nested under their
   parent in the UI (the data is already there).
7. **`SkillsService`** (doc 06): ~~inventory + system-prompt token-impact view~~ —
   **backend done.** `AkkoSkillsService` + `GET /api/skills?workspaceId=`: inventory from
   pi's own discovery, the byte-exact injected block from `formatSkillsForPrompt`, and
   per-skill cost measured *by difference* (what removing it would save). Deliberately no
   `setEnabled` — pi offers no per-session override, so the only toggle is mutating the
   user's skill frontmatter, which is a decision to make rather than a gap to fill.
   Skills and agent types can now live in **canonical SQLite** (`workspace_skills`,
   `workspace_agent_types`), so a workspace's whole config travels in the database file —
   necessary for doc 12, where a session may run on any node. pi still reads skill bodies
   from disk, so rows are materialized into `<cwd>/.akko/skills/` and merged into pi's
   `ResourceLoader`; files win on a name collision. That ownership is what unlocked
   `setHiddenFromPrompt` (`POST /api/skills/:name/visibility`) without rewriting user
   files. **Next:** the Skills UI (inventory + live budget + prompt preview, doc 06).
8. **Session lifecycle + touch-friendly list controls.** `rename` is implemented;
   **archive** and **delete** do not exist as verbs at all, and both need domain design
   before UI:
   - *Archive* is the easy one — a flag on `SessionRef`, filtered out of the list and the
     Jazz `sessions` query. Reversible, no data questions.
   - *Delete* is not. It has to decide what happens to canonical SQLite entries (doc 04
     says canonical data never lives only in Jazz — so is delete a tombstone, a soft
     delete, or a real purge?), and Jazz row deletes are tombstones that cannot be
     re-created under the same id (doc 14). Soft-delete is very likely the answer.

   The UI question is shared: today rename is a `✎` control revealed on hover/focus, which
   is a **desktop-first affordance** and does not scale to three actions. This app is
   explicitly meant to work on mobile (doc 08), so the list needs a control pattern that
   is native to touch — most likely **swipe-to-reveal actions** on a row, possibly with a
   long-press menu, and the hover control kept as the pointer equivalent. Worth designing
   once, when archive/delete land, rather than bolting a second affordance onto rename.
   *(The current `✎` is at least always in the DOM and keyboard-reachable — only its
   opacity is hover-driven — so it is usable-but-undiscoverable on touch, not broken.)*

**D. Multiuser/auth**
8. ~~**Real auth**~~ — **done, verified live** ([doc 16](./16-auth.md)): Better Auth
   in-process (passkey + jwt plugins), tables in canonical SQLite; the gateway validates
   the session cookie on HTTP **and** at WS upgrade to derive `principalId` (retiring the
   trusted `?principal=` / `x-akko-principal`); `MembershipStore` + `RoleBasedPolicy`
   replace `AllowAllPolicy`. Passkey-only signup collects full name + email and mints the
   first passkey in a **single** WebAuthn prompt. The Jazz read-ACL runs off the same JWT.
   *Deferred:* per-user workspaces, account recovery, gateway CORS.
9. **Multiplayer rendering** — attribution per message, presence, mailbox/queue feedback.
   (Unify step 4; note two members of a workspace currently see all of its sessions, which
   is the intended single-workspace v1 shape — isolation is per *workspace*, not per user.)

**E. Testing/infra**
10. ~~**Frontend tests** via vitest + testing-library~~ — **done**. 34 jsdom unit tests
    and 12 Storybook browser tests via `@storybook/addon-vitest` (Playwright); Storybook 10
    for isolated design. Jazz is mocked (`.storybook/mocks/`) so Jazz-coupled components
    render without a runtime.
11. Consider migrating the `ConversationStore` from linear messages to full
    tree/branch/compaction fidelity when needed (doc 04, route 3).

**F. Later (design done, not built)**
12. Memory + `SearchIndex` (doc 07/13); container isolation (doc 09); distributed
    execution — daemon + node↔Hub link + replication (doc 12).

## Known gaps & caveats

- **`dev:server` runs under `bun --watch`.** Before that it did not, which made backend
  fixes appear not to work: the running gateway kept serving the old code and the only
  clue was the process start time predating the change. Schema changes still need a full
  `bun run dev` restart (the in-memory sync server keeps its catalogue).
- **Text and tool calls are independent, not alternatives.** One assistant message can
  both speak and call tools ("I'll locate the docs" + `bash`), so it projects **two** rows
  — the text, then a `role: "tool"` record at `ts + 1ms` so it sorts after. Treating them
  as either/or silently dropped the tool call from the transcript whenever the model also
  spoke; only the transient live chip showed it. The same either/or mistake appears in the
  `activity` row below, which is worth noticing as a pattern.
- **The `activity` row carries concurrent live states, not one.** A turn commonly streams
  a sentence *and then* calls a tool, so `text` (streamed) and `toolLabel` are separate
  columns and the UI renders both. Overloading one column made the sentence disappear when
  the tool started and reappear when the message committed — a visible flicker. Likewise
  a committed assistant message only retires the row if no tool is still running.
- **Every pi-session construction must go through `#buildSession`.** `spawn_subagent` was
  once attached only on create, so any *rehydrated* session silently lost it — while the
  model, seeing earlier successful calls in its own transcript, kept calling a tool that
  no longer existed ("Tool spawn_subagent not found"). Create/rehydrate divergence is
  invisible until a session goes cold, which is why the tool set is now derived from
  `SessionRef.kind` inside one function rather than passed in by each caller.

- **jazz-tools is alpha** (`2.0.0-alpha.x`) — pinned; expect breaking changes on bumps.
  **Four non-obvious behaviours cost real debugging time** (all fixed, all now covered by
  tests — details in doc 14):
  1. **Deletes are tombstones.** Re-`upsert`ing a deleted row id fails forever
     (`WriteError: row already deleted`). The `activity` row is now retired to
     `kind: "idle"` instead of deleted. Symptom: the live indicator worked on a session's
     first turn and never again.
  2. **The browser client must use `driver: { type: "memory" }`.** The default
     (`persistent`) is an OPFS store behind a SharedWorker that outlives the `--in-memory`
     dev sync server, so the browser reads a stale local database. Symptom: queries
     succeed, return **0 rows, no error**.
  3. **The projection must be rebuilt from canonical.** `rebuild()` was a stub, so a
     session's history was missing from Jazz after any sync-server restart.
  4. **`CatalogueWriteDenied` in the browser console is benign.** The client re-publishes
     an already-deployed schema and is refused because catalogue writes are admin-only.
     It is a `WARN`, not a read failure — it cost several rounds as a red herring.
- **Schema changes need a full `bun run dev` restart** — the in-memory sync server keeps its
  old catalogue and `dev:server` doesn't auto-restart (doc 14).
- **Local-first read latency:** a fresh one-shot Jazz query returns empty until sync
  completes; the browser reads reactively via `QuerySubscription` (doc 14). Transient
  states can be **coalesced away** entirely, so don't assert on them.
- **Row order is not insertion order** in Jazz (ids are content-derived) — queries must
  `orderBy("createdAt")`, and entry timestamps are monotonic so that ordering is correct.
- **ConversationStore** persists linear conversation only (no branch/compaction yet).
- **Inference** is the global pi default; no per-tenant credentials or routing yet.
- **Vite's WS proxy is broken under Bun** (`socket.destroySoon is not a function`), so the
  browser connects the WS straight to the gateway in dev via `VITE_WS_URL` (doc 16).
- The **write tool used during development** intermittently appends stray
  `</content>`/`</invoke>` tags to files; strip + re-verify after batch writes.
- **Auth loose ends** (doc 16): no gateway CORS (dev is same-origin); no committed test
  for `/api/models` or the 403 non-member branches; JWT refresh-on-expiry is not wired
  (`JazzClient.updateAuthToken(...)` is the seam).