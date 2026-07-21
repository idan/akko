# 10 — Core Interfaces

This document maps the architecture (docs 00–09) to the concrete TypeScript design
skeleton in [`packages/core/src`](../../packages/core/src). These are **interfaces
and types only** — the compilable shape of the system. Each file carries detailed
JSDoc; this is the overview and the "why each exists" summary.

> Status: design skeleton. No behavior is implemented. pi packages are declared as
> optional peer dependencies so the types resolve when installed.

## Dependency flow

```
domain ──▶ authz
   │
   ├──▶ workspace ──▶ (pi: AuthStorage, ModelRegistry, ResourceLoader, SessionManager, SettingsManager)
   │
   ├──▶ conversation-store ──▶ (pi: SessionManager)
   │
   ├──▶ events ──▶ projector
   │        │
   │        └──▶ (pi: AgentSessionEvent)
   │
   ├──▶ session-runtime ──▶ (pi: AgentSession)     [uses domain, mailbox]
   │
   ├──▶ session-registry ──▶ session-runtime        [lazy liveness, subagents, HostResolver]
   │
   ├──▶ router ──▶ (pi/ai: Model, ThinkingLevel; pi: ModelRegistry)
   ├──▶ memory
   └──▶ skills
```

`domain.ts` depends on nothing. pi is only referenced where a real pi object is
consumed. Everything else is Akko's own vocabulary.

## The modules

### `domain.ts` — identity everywhere (doc 02)
The multiuser primitives: `Principal`, `Workspace`, `Membership`, `SessionRef`, and
the attributed `Command`. Branded ids (`PrincipalId`, `WorkspaceId`, `SessionId`,
`EntryId`, …) prevent id mix-ups once many coexist. `CommandVerb` is the closed set
of mutating operations — the only way to change a session. This file is the "bake in
now" invariant from doc 02 in code form.

### `authz.ts` — the single gate (doc 02/03)
`AuthorizationPolicy.authorize(ctx, action, resource)` is the choke point every
mutating command passes through, and where concurrency policy is expressed.
`AllowAllPolicy` is the day-one single-user implementation. Swapping in a real
role/state-aware policy touches no callers.

### `workspace.ts` — tenancy → pi params (doc 01/02/09)
`WorkspaceRuntime` is the resolved bundle of pi's per-call parameters for one
workspace. `WorkspaceRuntimeFactory` builds/caches it. `CredentialProvider` and
`WorkspaceExecution` are the two deferred seams (per-tenant creds; host-vs-container
isolation). This is the module that makes "no pi fork" true.

### `conversation-store.ts` — durable canonical persistence (doc 04)
The seam between pi's session persistence and Akko's storage. `load()`/`create()`
rehydrate a pi `SessionManager`; `persistEntry()` and the `record*` hooks capture
committed state. Deliberately **durable-only** — it must not know about Jazz/UI.
`CommittedEntry` carries pi's opaque entry plus Akko's `actorId` side-field (no
content duplication).

### `events.ts` + `projector.ts` — fan-out and the realtime read-model (doc 04/08)
`DomainEvent` wraps pi events with session identity + attribution for multiplexed
transport. `EntrySink` is the committed-entry consumer; `ConversationStore` and
`Projector` are both sinks and are **siblings** (neither goes through the other).
`EventBus` is the pub/sub the WS gateway subscribes to. `Projector.rebuild()`
guarantees the projection is recreatable from canonical. `NullProjector` is the
no-Jazz default.

### `session-runtime.ts` — the actor / single writer (doc 03)
`SessionRuntime` owns one live pi `AgentSession` and is its sole mutator. `Mailbox`
is the single-consumer, in-order, attributed queue; `post()` is the only sanctioned
way to change a session. `ConcurrencyPolicy` (default `free-for-all`) lives here and
is consulted alongside `authorize()`. `dispose()` reflects liveness-is-disposable.

### `session-registry.ts` — lazy liveness + subagents (doc 03/08)
`SessionRegistry` maps session id → live `SessionRuntime`, creating on demand
(rehydrate) and evicting when idle. `spawnSubagent()` registers subagents as
first-class sessions (`kind: "subagent"`, `parentSessionId`) so the UI renders them
uniformly. `HostResolver` is the cross-node routing seam (constant today).

### `router.ts` — model routing (doc 05)
`ModelRouter` separates `resolveModelString()` (fuzzy string→Model) from
`routeTask()` (natural-language task→model via a cheap classifier over `catalog()`).
Both read the caller's per-workspace `ModelRegistry`, so routing is per-tenant.
`RoutingMode` (automatic/advisory/agent-driven) is policy, defaulted per session kind.

### `memory.ts` — deferred seam (doc 07)
`MemoryProvider` (`recall`/`remember`) with a domain-shaped `MemoryScope`
(workspace + optional principal/session + subagent visibility). `NullMemoryProvider`
is the no-op default. Implemented later, informed by hermes/FTS learnings.

### `skills.ts` — inventory + prompt impact (doc 06)
`SkillsService` lists skills, computes `SkillImpact` (per-skill + total token cost
and the exact injected block), toggles enable/hidden state, and previews the full
system prompt — all against pi's introspection APIs.

### `sqlite.ts` — the runtime-coupled seam (doc 11)
`SqliteAdapter` abstracts the native SQLite driver (`bun:sqlite` default,
`node:sqlite` for Node/Deno). Interface-only; the concrete impl lives in a future data
package so `core` stays runtime-agnostic. This is the one file the runtime choice
touches.

### `node.ts` + `replication.ts` + `node-link.ts` — distributed execution (doc 12)
`Node` and the Hub-side `NodeDirectory` track execution points and resolve
`session → workspace → node`; `InferenceRouting` toggles node-held vs hub-brokered
keys. `ReplicationSource` (node write-ahead) and `ReplicationSink` (Hub ingest) carry
cursor-based, idempotent, append-only log shipping (consistency model B).
`NodeLinkMessage` + `NodeLink` define the multiplexed node↔Hub protocol
(control/command/entry/event) — the wire form of the `Mailbox` / `EntrySink` /
`EventBus` seams. `Workspace.nodeId` records placement; `HostResolver` becomes the
session-facing view over `NodeDirectory`.

## What is intentionally NOT here

- **Concrete implementations** (JSONL store, Jazz projector, SQLite DB, WS gateway,
  the mailbox loop, the classifier prompt). Those are the next step, one module at a
  time, behind these interfaces.
- **Wire protocol** for the WebSocket/HTTP transport (doc 08). It will be defined in
  a `server` package and can borrow pi's RPC command/event envelopes as a model.
- **The frontend** (`web` package, Svelte 5 + bits-ui).

## Suggested next implementation order

1. ✅ `AllowAllPolicy` + `domain` ids + an in-memory `EventBus` (trivial, unblocks all).
2. ✅ `WorkspaceRuntimeFactory` (host isolation, shared creds) → prove `createAgentSession`.
3. ◑ A real `Mailbox`/`SessionRuntime` (done) + `ConversationStore` — **SQLite-canonical
   done** (`SqliteConversationStore` + `BunSqliteAdapter`), with entry capture +
   attribution. Full tree/branch fidelity (route 3) deferred.
4. ◑ `SessionRegistry` — create/list/evict + **durable refs (`SqliteSessionIndex`) and
   lazy rehydration done**; subagents next. **WS gateway done** (`@akko/server`):
   `Bun.serve` WS + HTTP, CQRS (attributed commands -> mailbox, `EventBus` -> clients),
   verified end-to-end against the real registry over a live WebSocket.
5. `ModelRouter` (string resolver first, then the classifier).
6. `SkillsService`.
7. ◑ Frontend (Svelte 5 + bits-ui) against `@akko/server` — **first slice done**
   (`@akko/web`): session list, live streaming chat, composer; typed WS/HTTP client +
   pure conversation reducer; responsive/mobile layout. Wire types extracted to
   `@akko/protocol` so the browser build pulls no `bun`/pi runtime. Backlog fetch for
   rehydrated sessions, multi-client attribution rendering, and auth next.
8. ◑ **Jazz projector** — thin vertical slice done on **`jazz-tools@2.0-alpha`**
   (relational DB, doc 14): `@akko/schema` `messages` table, backend `JazzProjector`
   inserting rows via a backend `Db`, frontend `QuerySubscription` read view (opt-in via
   `VITE_JAZZ`), proven by an in-process test against a local Jazz server. Bundle ~82 KB
   gzipped. Next: standalone server e2e, row policies, migrate default reads, JWT auth.
9. Later: container isolation, `MemoryProvider` + `SearchIndex`,
   `HostResolver`/`NodeDirectory` + node↔Hub link (distributed execution, doc 12).

> Progress lives in `packages/{runtime,server,web,schema,protocol}`, verified with
> `bun test` (50 tests; live pi prompt + live WS round-trip under `AKKO_LIVE=1`; SQLite
> FTS5; durable rehydration; Jazz projection cross-account read) plus `svelte-check` +
> `vite build`.
