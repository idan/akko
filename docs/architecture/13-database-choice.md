# 13 — Database Choice: SQLite now, SearchIndex seam for later

**Decision: use SQLite (via `bun:sqlite`) behind `SqliteAdapter`. Do not adopt the
Turso engine now. Add a `SearchIndex` seam so vector/semantic retrieval can be added
later without touching callers.**

## Disambiguation

"Turso" names two different things:

1. **The Turso engine ("Limbo")** — SQLite rewritten in Rust, with FTS delegated to
   Tantivy. This is what [`docs/fts5-vs-turso-fts.md`](../fts5-vs-turso-fts.md)
   compares against FTS5. **This is the one under consideration** (the intent is to use
   the engine, not Turso Cloud).
2. **Turso Cloud / libSQL** — the mature SQLite *fork* (server, sync, native vectors).
   Not in scope; noted only to avoid confusion.

## Why SQLite now (not the Turso engine)

- **Native fit for the locked runtime.** `bun:sqlite` is synchronous, zero-dep,
  single-file portable, and ships FTS5 + `bm25()` (verified empirically, doc 11).
- **FTS5 is a proven-sufficient memory baseline.** The reference system
  `pi-hermes-memory` is FTS5-only, no vectors — so keyword/BM25 memory is a validated
  starting point, not a compromise.
- **The Turso engine's current gaps are exactly what memory needs** (per our own FTS
  doc): no read-your-writes (breaks "remember → recall"), no `snippet()` (memory wants
  context windows), no `NEAR`/contentless, and manual `OPTIMIZE INDEX` (operational
  burden on every node). It is feature-gated and moving fast. Not ready to be our
  primary store today.
- **Distribution does not argue for it.** Our node↔Hub replication is single-writer,
  append-only log shipping over a purpose-built protocol (doc 12). No engine feature
  changes that.

## Retrieval over stored sessions is coming — vectors will play a role

The likely future need is **semantic retrieval over stored sessions/memory**, which
implies vector ANN in addition to FTS5. We accept that now and prepare for it with a
seam rather than a premature engine switch:

- Keep all SQLite access behind **`SqliteAdapter`** (doc 11).
- Put all retrieval behind **`SearchIndex`** (`packages/core/src/search.ts`): index
  text + optional embeddings, query by keyword and/or vector. The first implementation
  is FTS5-backed keyword search; a later implementation adds vectors.

When vectors become a hard requirement, the options are `sqlite-vec` (a loadable
extension; note `bun:sqlite` needs a custom SQLite build to load extensions on macOS)
or the Turso engine's evolving stack — evaluated then, against `SearchIndex`, with no
change to memory or session code.

## Memory-locality note (for the future memory doc)

Memory recall runs on the **node**, inside `before_agent_start`, every turn. For
latency and partition-resilience (model B, doc 12), the node should query memory
**locally** (a local FTS-capable store), replicating writes to the Hub. `bun:sqlite`
on every node gives us this uniformly — reinforcing the single-stack SQLite choice
end-to-end.

## Summary

- **Now:** SQLite / `bun:sqlite`, FTS5 for search, everything behind `SqliteAdapter`
  and `SearchIndex`.
- **Trigger to revisit:** semantic/vector retrieval becomes a hard requirement.
- **Revisit path:** add a vector-capable `SearchIndex` implementation; the engine
  choice is a localized decision at that point, not a rewrite.
