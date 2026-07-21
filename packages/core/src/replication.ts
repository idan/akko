/**
 * Replication — cursor-based, append-only log shipping between a node and the Hub
 * (doc 12, consistency model B).
 *
 * pi sessions are append-only trees of entries with stable ids, so replication is log
 * shipping: idempotent by `EntryId`, resumable from a cursor after disconnect. The
 * node is the single writer; the Hub ingests. Neither side ever rewrites history.
 */

import type { CommittedEntry } from "./conversation-store.ts";
import type { EntryId, SessionId } from "./domain.ts";

/**
 * The last entry the Hub has durably ingested for a session. The node resends
 * strictly after this on reconnect. `null` means nothing ingested yet.
 */
export interface ReplicationCursor {
  sessionId: SessionId;
  lastEntryId: EntryId | null;
}

/**
 * Node side: the durable write-ahead log for hosted sessions and the source of the
 * entry replication channel. The host runtime appends here first (survives crash and
 * partition), then a replication client tails it to the Hub.
 */
export interface ReplicationSource {
  /** Durably append a committed entry locally (write-ahead). Applied before/around send. */
  appendLocal(sessionId: SessionId, entry: CommittedEntry): Promise<void>;

  /** Read entries strictly after `cursor`, in tree/append order, for (re)sending. */
  since(sessionId: SessionId, cursor: EntryId | null): Promise<CommittedEntry[]>;

  /** Subscribe to new local appends so the replication client can stream promptly. */
  subscribe(sessionId: SessionId, listener: (entry: CommittedEntry) => void): () => void;

  /** Highest locally-durable entry id (the node's own high-water mark). */
  localHead(sessionId: SessionId): Promise<EntryId | null>;
}

/**
 * Hub side: idempotent ingest of replicated entries into the aggregate canonical/
 * replica store, returning the advanced cursor to ack back to the node.
 */
export interface ReplicationSink {
  /**
   * Ingest a replicated entry. MUST be idempotent by `entry.id` (a resent entry is a
   * no-op). Returns the current cursor after ingest so the node can advance its ack.
   */
  ingest(sessionId: SessionId, entry: CommittedEntry): Promise<ReplicationCursor>;

  /** The Hub's current durable cursor for a session (what to resume from). */
  currentCursor(sessionId: SessionId): Promise<ReplicationCursor>;
}
