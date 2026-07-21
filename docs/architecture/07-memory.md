# 07 — Memory

## Decision: punt on implementation, bake in the seam

We are **deferring** a real memory implementation. The reason is not that memory is
unimportant — it's that existing providers impose an architecture that collides with
Akko's tenancy model, and getting memory scoping wrong is expensive to undo.

## Why the existing providers don't fit (yet)

`pi-hermes-memory` (SQLite FTS5, policy memory injected via `before_agent_start`,
session search, secret scanning, correction detection, auto-consolidation, aging) is
capable and well-tested. But its **scoping model is project/local/user**, pinned to
a **cwd-per-project, single-user** worldview. That collides head-on with Akko's
`Workspace` / `Principal` model:

- Whose memory is it — the workspace's, or a principal's within it?
- Is it shared across all members of a workspace?
- Is it visible to subagents? To viewers?

These are exactly the questions a multiuser system must answer explicitly, and
hermes answers them for a different world. Adopting it now would either constrain our
tenancy model or require forking it immediately.

## What we do now

Bake in a **`MemoryProvider` seam** and leave it a no-op:

```ts
interface MemoryProvider {
  recall(scope: MemoryScope, query: string): Promise<MemoryHit[]>;
  remember(scope: MemoryScope, item: MemoryItem): Promise<void>;
  // wired into a before_agent_start hook to inject recalled memory
}
```

The scope is keyed the way our domain actually works:

```ts
type MemoryScope = {
  workspaceId: string;
  principalId?: string;   // optional per-principal overlay on workspace memory
  sessionId?: string;     // optional session-local memory
  subagentVisible?: boolean;
};
```

This is a **superset** of hermes's project/local/user scopes, which is why it's
worth owning rather than adapting.

## What we borrow (ideas, not architecture)

From `pi-hermes-memory` and the Hermes agent lineage, the good ideas to carry into
our own implementation later:

- **FTS index** over memory + past sessions (see `docs/fts5-vs-turso-fts.md` for the
  SQLite FTS5 vs. Turso FTS comparison already done).
- **Secret scanning on write** — never persist credentials into memory.
- **Correction detection** — capture "actually, do X instead" as durable learning.
- **Aging / consolidation** — compress and expire low-value memories.
- **Token-aware policy memory** — budget how much memory is injected per turn
  (mirrors the skills budget concern in doc 06).

## Where it plugs in

When implemented, memory is injected through the same `before_agent_start` extension
hook pi provides, bound **per session** (extensions are session-scoped — doc 01).
Recall results become injected context; new memories are written by the
single-writer `SessionRuntime` (doc 03/04), keeping the authority model intact.

## Interfaces

See `packages/core/src/memory.ts` and doc 10: `MemoryScope`, `MemoryItem`,
`MemoryHit`, `MemoryProvider` (no-op default: `NullMemoryProvider`).
