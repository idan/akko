# 14 — Jazz Evaluation and Integration

**Decision gate result: Jazz's core runs on Bun.** The one open risk from doc 11
(does Jazz's server worker run on Bun?) is retired. What remains is an architecture
choice about *how much* to adopt and *when*, because it reshapes the frontend data
flow — hence deciding it before building more UI.

## What was verified (empirically, on Bun 1.3.14)

Installed `jazz-tools@0.20.19`, `cojson@0.20.19`, `jazz-run@0.20.19` and ran a probe:

| Check | Result |
|-------|--------|
| WASM crypto init (`cojson/crypto/WasmCrypto`) | ✅ initializes on Bun |
| `LocalNode.withNewlyCreatedAccount` (account + node) | ✅ |
| CoValue write/read (`Group.createMap` → set/get) | ✅ round-trips |
| `jazz-tools` + `jazz-tools/worker` import | ✅ (`co`, `startWorker`) |
| Native builds required? | ❌ — WASM backend avoids NAPI; only `@parcel/watcher` (a `jazz-run` CLI dep) postinstall was blocked, irrelevant to runtime |

Surfaces available: `jazz-tools/worker` (server worker), `jazz-tools/svelte`
(Svelte 5 runes bindings), `jazz-tools/better-auth/auth/{server,svelte}` (auth),
`jazz-tools/ssr`. Sync server: `jazz-run sync` (self-hostable WS server,
`--in-memory` or `--db file`; Jazz Cloud is the hosted alternative).

## What Jazz is (in one paragraph)

A local-first sync engine. Data lives in **CoValues** (CRDT objects: `CoMap`,
`CoList`, `CoFeed`, …) owned by **Accounts** and permissioned via **Groups**. Clients
and a backend **worker** each hold a local node; CoValues sync through a sync server
and merge via CRDT. Reads are reactive subscriptions; writes are permissioned by
Group role.

## How it maps onto Akko (CQRS preserved)

The golden rule from doc 04 holds: **Jazz is a projection of canonical SQLite, never
the source of truth; commands never flow through Jazz.**

```
frontend ──command (attributed, WS/HTTP)──▶ backend: mailbox → single writer → pi → SQLite (canonical)
                                                                   │
                                              backend WORKER projects committed entries ▼
frontend ◀──── reactive CoValue subscription (jazz-tools/svelte) ──── Jazz CoValues (read model)
```

| Akko concept | Jazz concept |
|--------------|--------------|
| `Principal` | Account |
| `Workspace` / `Membership` (roles) | Group (members + read/write roles) |
| Projected conversation (read model) | per-session `CoList` of message `CoMap`s |
| Presence / typing / drafts (ephemeral) | client-writable CoValues in a shared Group |
| Canonical conversation (source of truth) | **stays in SQLite** (doc 04) |
| Deferred auth | `jazz-tools/better-auth` integration |

- **Backend worker** (`startWorker`, runs on Bun ✅) holds the server Account and is
  the **single writer of canonical-projection CoValues**. It implements the
  `Projector` seam (doc 04) — a sibling sink fed by `SessionRuntime`.
- **Frontend** subscribes to CoValues via `jazz-tools/svelte`. This **replaces the
  client-side event reducer** (`conversation.ts`) and the event-fanout WebSocket for
  *reads*.
- **Commands stay out-of-band** (WS/HTTP → mailbox → `authorize()` → single writer).
  Group permissions make canonical projection CoValues **read-only to clients**.
- **Identity/ACL fit is strong**: Principal→Account, Workspace→Group. Group ACL can
  become the substrate for *read* authorization; *write* authorization stays on the
  command path. Adopting Jazz also front-loads the deferred **auth** story via Better
  Auth.

## The streaming question (must decide)

Live token-by-token assistant text is high-frequency. Options:
1. **Ephemeral streaming stays on the WS** (or a Jazz `CoFeed`/ephemeral CoValue);
   only the **finalized message** becomes a canonical projection CoValue. Keeps
   streaming low-latency; Jazz holds durable/collab state. **Recommended.**
2. Stream deltas straight into a CoValue field — simpler model, but CRDT overhead per
   token and more sync traffic.

Recommendation: keep streaming ephemeral (WS or CoFeed), commit finalized messages to
canonical CoValues. This is consistent with "ephemeral collab state is disposable"
(doc 04).

## What changes across the stack if we adopt

1. **Frontend reads** — replace `conversation.ts` + WS event handling with Jazz
   subscriptions. `AkkoClient` shrinks to: commands out + Jazz for state. *(This is the
   part that becomes throwaway if we build backlog/history/more UI on the current model
   first — the reason to decide now.)*
2. **Backend** — add the worker + a **`JazzProjector`** (implements `Projector`) wired
   into `SessionRuntime` as a sibling sink.
3. **Shared schema** — a small package of CoValue schemas (Session, Message,
   Workspace) imported by worker + frontend.
4. **Identity/ACL** — realize Principal→Account, Workspace→Group (interfaces already
   exist in `core`; this is their concrete mapping).
5. **Infra** — run `jazz-run sync` (self-hosted) alongside the gateway; another
   process (or Jazz Cloud).

## Costs / risks

- **Dependency weight**: `jazz-tools` pulls prosemirror/tiptap/zod. Tree-shakeable;
  worker + svelte subsets are what matter — check frontend bundle size.
- **Version velocity**: 0.20.x, fast-moving (like pi). Pin versions.
- **Discipline required**: Jazz must remain a *projection* of SQLite. If canonical
  conversation ever lives only in a CoValue, we've violated doc 04 and lost the
  single-writer/rehydration guarantees. The CRDT is for sync/merge of the projection +
  ephemeral state.
- **Complexity vs. payoff**: for single-user it's arguably overkill; the payoff
  (multiplayer, offline, local-first) is real but not needed *yet*.

## Recommendation

The direction is sound and Bun-viable, and the identity/ACL fit is a bonus (it also
answers deferred auth). But adopt **incrementally**, not big-bang:

1. Keep the **WS command path** — it's the write channel either way (not throwaway).
2. **Prove a thin vertical Jazz slice first**: backend worker + a minimal
   `Session`/`Message` CoValue schema + a `JazzProjector` fed by `SessionRuntime` +
   frontend rendering one session from a CoValue subscription. This validates
   backend-projects → Jazz → Svelte-renders end-to-end on our stack before committing
   the whole frontend to it.
3. Only after the slice proves out: migrate frontend reads off the reducer, add
   presence, then Better Auth.

Concretely: **do the thin vertical slice next**, behind the existing seams
(`Projector`, `EventBus`), so the current WS path keeps working and we can compare.

## Status

**Thin vertical slice implemented and verified** (behind the existing seams; the WS path
still works unchanged):

- `@akko/schema` — `Conversation` / `Message` CoValue schemas (`co`/`z`).
- `@akko/server` `JazzProjector` (implements `SessionProjector`) + worker bootstrap
  (`startWorker`, WASM crypto). Wired into the registry as a sibling entry-sink; the
  gateway exposes each session's `jazzId`. Enabled in `main.ts` only when
  `JAZZ_SYNC` + worker creds are set (else `NullProjector` behavior).
- `@akko/web` — `JazzSvelteProvider` (guest mode) + a `CoState`-backed message view,
  toggled against the live WS view per session.
- Automated proof: `jazz-projector.test.ts` — the projector (as the worker account)
  writes a public CoValue and a *separate* account reads the messages back, in-process
  (no network), with attribution. 50 tests green overall; `svelte-check` + `vite build`
  pass.

Known costs observed: the frontend bundle grew to ~433 KB gzipped (jazz-tools pulls
prosemirror/tiptap) — code-splitting / narrower imports are a follow-up. Live
streaming stays on the WS; only finalized messages are projected. Next: run against a
real `jazz-run sync` server, then migrate the default frontend read path to Jazz,
presence, and Better Auth.