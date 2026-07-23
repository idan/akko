/**
 * ConversationStore — the durable/liveness split made concrete (doc 03/04).
 *
 * This is the seam between pi's session persistence and Akko's storage. Everything
 * above it treats the live `AgentSession` as a disposable cache: to bring a session
 * to life we `load()` it into a pi `SessionManager`; as the agent produces committed
 * entries we `persistEntry()` them.
 *
 * IMPORTANT (doc 04): the `ConversationStore` is durable/canonical ONLY. It must not
 * know about Jazz or any UI transport. The realtime projection is a *separate* sink
 * (`Projector`, `projector.ts`) fed by the same committed-entry stream.
 *
 * Backing implementations (see `docs/architecture/01-pi-as-foundation.md`):
 *   1. JSONL-canonical      — pi writes JSONL; our DB indexes it. (recommended start)
 *   2. DB-canonical (mirror)— inMemory session + capture entries into SQLite.
 *   3. DB-canonical (native)— implement pi-agent-core's `SessionStorage` over SQLite.
 * The interface hides which one is in use.
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EntryId, SessionId } from "./domain.ts";

/**
 * A single appended entry in pi's session tree, plus Akko's attribution side-data.
 *
 * The `entry` is pi's own tree entry (message / model_change / compaction /
 * branch_summary / label / session_info / custom). We keep it opaque (`unknown`)
 * here so the store can serialize pi's shape verbatim without Akko re-modeling it.
 * `actorId` is our attribution side-field — it is NOT part of pi's entry, and is
 * stored keyed by `entry.id` so we never duplicate conversation content (doc 04).
 */
export interface CommittedEntry {
  id: EntryId;
  parentId: EntryId | null;
  /** pi's serialized `SessionTreeEntry`. */
  entry: unknown;
  /** Who caused this entry (attribution side-table). `undefined` for agent output. */
  actorId?: string;
  ts: number;
}

/**
 * Durable, canonical persistence for one Akko session's conversation content.
 * Implementations own storage backend, versioning, and rehydration.
 */
export interface ConversationStore {
  /**
   * Rehydrate a session into a live pi `SessionManager`. For JSONL-canonical this is
   * `SessionManager.open(path)`; for DB-canonical it replays entries into an
   * in-memory manager (or backs it with a custom `SessionStorage`). Called lazily by
   * the `SessionRegistry` on first access (doc 03).
   */
  load(sessionId: SessionId): Promise<SessionManager>;

  /**
   * Create durable storage for a brand-new session and return its live manager.
   */
  create(sessionId: SessionId, options?: { parentSessionId?: SessionId }): Promise<SessionManager>;

  /**
   * Persist a committed entry. Called by the single-writer `SessionRuntime` as the
   * agent produces output. For JSONL-canonical pi already wrote the entry; this may
   * be a no-op for content and only record the `actorId` side-field. For DB-canonical
   * this is the authoritative write.
   */
  persistEntry(sessionId: SessionId, entry: CommittedEntry): Promise<void>;

  /** Mirror pi's branch move (leaf repositioning) so durable state matches. */
  recordBranch(sessionId: SessionId, leafId: EntryId | null): Promise<void>;

  /** Mirror pi's label set/clear. */
  recordLabel(sessionId: SessionId, targetId: EntryId, label: string | undefined): Promise<void>;

  /**
   * Mirror a compaction summary. Provided explicitly (rather than inferred from
   * `persistEntry`) because compaction changes context-building semantics and callers
   * may want to react (doc 04).
   */
  recordCompaction(
    sessionId: SessionId,
    summary: string,
    firstKeptEntryId: EntryId,
    tokensBefore: number,
  ): Promise<void>;

  /** Read the durable actor attribution for an entry (used by the Projector/UI). */
  getActor(sessionId: SessionId, entryId: EntryId): Promise<string | undefined>;

  /**
   * Read a session's committed entries in append order (canonical history). Used by the
   * gateway to seed the UI on (re)select without bringing the session live — a cheap
   * SQLite read, not a model rehydration (doc 04/08).
   */
  getEntries(sessionId: SessionId): Promise<CommittedEntry[]>;
}
