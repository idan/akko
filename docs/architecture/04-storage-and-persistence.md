# 04 — Storage and Persistence

This is the most consequential area, because the durable/liveness split (doc 03)
leans entirely on getting storage responsibilities right.

## What pi stores vs. what Akko stores

pi's `SessionManager` persists exactly **one thing**: the **session entry tree**
(messages + context-affecting metadata + labels + name + extension `custom`
entries). See doc 01 for the full list and the pluggability seam. pi stores nothing
about identity, ownership, ACL, presence, memory, routing, or **authorship**.

The clean rule:

> pi's entry stream is the **single source of truth** for conversation content.
> Everything else is either a **side-table keyed to pi's ids**, or a **derived index
> we can rebuild**. Never keep a second source of truth for the conversation.

| Data | Where | Relationship to pi |
|------|-------|--------------------|
| Session entry tree (canonical conversation) | `ConversationStore` | *is* pi's content |
| Workspaces, principals, memberships | our DB | independent |
| Session index (id, workspace, owner, title, leaf, updatedAt) | our DB | derived from entries; for fast listing/ACL |
| Attributed command log + per-entry `actorId` | our DB | side-table keyed by pi entry id — **no content duplication** |
| Memory / search | our DB (FTS index) | derived copy of message text — legitimate duplication |
| Client-facing realtime projection | Jazz | derived projection for rendering/collab — legitimate |

**What is legitimately "stored twice":** only **derived read-optimizations** (a
search index, a client projection) — never authority. A single writer keeps them
consistent with the canonical entry stream.

## The ConversationStore seam

We place a `ConversationStore` interface between pi and durable storage from the
first commit. Everything above it treats the live session as a disposable cache —
this interface *is* the durable/liveness split made concrete.

```ts
interface ConversationStore {
  load(sessionId): Promise<SessionManager>;      // rebuild the live tree
  persistEntry(sessionId, entry): Promise<void>;
  // + branch / label / compaction hooks mirrored from SessionManager
}
```

Backing options (doc 01 details the three routes):

1. **JSONL-canonical.** pi writes JSONL; SQLite is purely our index. *Rejected as the
   starting point* — see the finding below.
2. **DB-canonical via mirror.** `SessionManager.inMemory()` for the live tree + we
   capture committed messages into SQLite; rehydrate by replaying them into a fresh
   in-memory `SessionManager`. **This is the implemented route** (`@akko/runtime`
   `SqliteConversationStore`).
3. **DB-canonical via `SessionStorage`.** Implement pi-agent-core's `SessionStorage`
   over SQLite and drop below `createAgentSession`. Cleanest single store; a later
   option if we need full tree/branch fidelity in the durable layer.

> **Empirical finding (verified against pi 0.80.10):** pi's built-in `SessionManager`
> file writer is **deferred, has no public `flush()`, and is coupled to pi's own
> runtime lifecycle** — a bare manager never wrote its file even after ~2s. It is built
> for the interactive TUI, not for a backend that needs durability guarantees,
> attribution, and replication cursors (doc 12). So Akko **owns persistence** (route 2)
> rather than relying on pi's writer. `createAgentSession` *restores* conversation from
> a populated in-memory `SessionManager` (also verified), which is exactly what makes
> replay-based rehydration work.

The implemented `SqliteConversationStore` appends each committed message to an
`entries` table (monotonic `seq`, idempotent by entry id — the replication shape from
doc 12) with an `actor_id` side-field, and rebuilds the conversation on `load()`.
Slice scope is linear conversation content + attribution; tree/branch/compaction
fidelity (route 3) is deferred behind the same interface.

Because the seam hides the choice, we can start at (2) and migrate to (3) later
**without touching the registry, mailbox, router, or web layer.**

## Single writer

"Single writer" is an **authority rule**, not one code object:

> For any given session, exactly one component may mutate canonical state — the
> backend `SessionRuntime` that owns the session (the mailbox consumer, doc 03).

What it forbids: **clients never write conversation content directly** — not to
SQLite, not to Jazz's authoritative fields. A browser does not "add a message"; it
posts a **command** to the mailbox. The backend applies it, the agent produces
entries, and only the backend commits them. This is essentially **CQRS**: commands
flow in, committed entries / read-models flow out.

## Two independent sinks (ConversationStore is NOT the Jazz writer)

A subtle but important separation: the `ConversationStore` must **not** write to
Jazz. Coupling durable persistence to the UI transport is wrong. Instead the
single-writer `SessionRuntime` fans committed entries to **two independent sinks**:

```
       ┌────────── mailbox (attributed commands in) ──────────┐
       ▼                                                       │
  SessionRuntime (THE single writer for this session)          │
       │ produces committed entries                            │
       ├───────────────▶ ConversationStore ──▶ SQLite  (durable, canonical)
       └───────────────▶ Projector         ──▶ Jazz    (realtime read-model)
                                                     ▲
                        clients render & collaborate; send commands ┘
```

Neither sink goes *through* the other. `ConversationStore` stays focused on being
the thing we rehydrate pi from; the `Projector` can be replaced or removed without
touching persistence.

## Jazz: realtime projection, not canonical store

[Jazz](https://jazz.tools/docs) is local-first CRDT sync — excellent for
**client-facing app state**. But the agent runs on the **backend**, not in the
browser, so the canonical conversation is generated server-side. Therefore:

- **Projected conversation in Jazz** ← derived from SQLite (backend writes, clients
  read). Fully **recreatable**: delete it, replay entries from SQLite, rebuilt.
- **Ephemeral collaborative state in Jazz** ← presence, typing indicators, cursors,
  unsent drafts, optimistic "pending" messages. Client-owned, **not** persisted to
  canonical, disposable by design. Losing it costs nothing.

So "the conversation is stored twice" is honest and fine: canonical in the
`ConversationStore`, *projected* into Jazz for the multiplayer UI. Two
representations, one writer, different jobs.

## Portability

The stated goal is portability (one SQLite file rather than a directory of little
files). Route (1) achieves "archive a folder"; routes (2)/(3) achieve the literal
single-`.db` goal. The seam lets us defer that decision until memory/search needs
(see doc 07 and the existing `docs/fts5-vs-turso-fts.md` notes) firm up the DB
choice.
