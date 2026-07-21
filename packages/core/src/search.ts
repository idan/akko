/**
 * SearchIndex — the retrieval seam (doc 13).
 *
 * All full-text and (future) semantic retrieval goes through this interface. The first
 * implementation is FTS5-backed keyword search over `bun:sqlite`; a later one adds
 * vector/embedding search for semantic retrieval over stored sessions and memory —
 * without changing callers (memory recall, session retrieval).
 *
 * This keeps the database decision (doc 13) localized: swapping FTS5 → FTS5+vectors →
 * a different engine is a change behind this interface, not a rewrite.
 */

/** A document to index. `text` is required; `embedding` optional until vectors land. */
export interface SearchDocument {
  /** Stable id, typically a workspace-scoped session/entry/memory id. */
  id: string;
  text: string;
  /** Arbitrary filterable fields (workspaceId, sessionId, kind, ts, ...). */
  fields?: Record<string, string | number | boolean | null>;
  /** Optional precomputed embedding for semantic search (future). */
  embedding?: Float32Array;
}

export interface SearchQuery {
  /** Keyword query (FTS5 syntax for the keyword backend). */
  text?: string;
  /** Query embedding for vector search (future; ignored by the keyword-only backend). */
  embedding?: Float32Array;
  /** Equality filters over `fields`. */
  filter?: Record<string, string | number | boolean | null>;
  limit?: number;
}

export interface SearchHit {
  id: string;
  score: number;
  /** Optional highlighted snippet around the match (FTS5 `snippet()`). */
  snippet?: string;
  fields?: Record<string, string | number | boolean | null>;
}

/**
 * Index + query. Implementations declare which query modes they support; the
 * keyword-only backend ignores `embedding`. Callers (e.g. `MemoryProvider`, session
 * retrieval) depend only on this interface.
 */
export interface SearchIndex {
  /** Whether this backend can answer vector queries. */
  readonly supportsVectors: boolean;

  upsert(doc: SearchDocument): Promise<void>;
  upsertMany(docs: SearchDocument[]): Promise<void>;
  delete(id: string): Promise<void>;

  /** Keyword and/or vector search, depending on the query and backend capability. */
  query(query: SearchQuery): Promise<SearchHit[]>;
}
