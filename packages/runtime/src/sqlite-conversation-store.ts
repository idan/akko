/**
 * SqliteConversationStore — SQLite-canonical `ConversationStore` (doc 04, route 3).
 *
 * We own conversation persistence rather than relying on pi's `SessionManager` file
 * writer: that writer is deferred, has no public flush, and is coupled to pi's own
 * runtime lifecycle (verified empirically — a bare manager never flushed). Owning
 * persistence also gives us the durable append log the replication cursors need
 * (doc 12) and the queryable store memory/search will build on (doc 13).
 *
 * Model: each committed conversation message is appended to an `entries` table with a
 * monotonic `seq`. Rehydration rebuilds an in-memory `SessionManager` by replaying the
 * stored messages — `createAgentSession` restores conversation context from it
 * (verified). Attribution (`actor_id`) is stored per entry as a side-field.
 *
 * Slice scope: linear conversation content (messages) + attribution. Full tree/branch
 * and compaction fidelity are deferred; the interface (`recordBranch`/`recordLabel`/
 * `recordCompaction`) is present so they slot in later without touching callers.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  CommittedEntry,
  ConversationStore,
  EntryId,
  SessionId,
  SqliteAdapter,
} from "@akko/core";

interface EntryRow {
  entry_id: string;
  parent_id: string | null;
  payload_json: string;
  actor_id: string | null;
  ts: number;
}

export class SqliteConversationStore implements ConversationStore {
  readonly #db: SqliteAdapter;
  readonly #cwd: string;

  constructor(options: { db: SqliteAdapter; cwd?: string }) {
    this.#db = options.db;
    this.#cwd = options.cwd ?? process.cwd();
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        entry_id     TEXT    NOT NULL,
        parent_id    TEXT,
        payload_json TEXT    NOT NULL,
        actor_id     TEXT,
        ts           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_id ON entries(session_id, entry_id);
    `);
  }

  async create(sessionId: SessionId): Promise<SessionManager> {
    // Fresh session: nothing persisted yet; the live tree is in-memory.
    return SessionManager.inMemory(this.#cwd);
  }

  async load(sessionId: SessionId): Promise<SessionManager> {
    const rows = this.#db
      .prepare(
        "SELECT entry_id, parent_id, payload_json, actor_id, ts FROM entries WHERE session_id = ? ORDER BY seq ASC",
      )
      .all<EntryRow>(sessionId);

    const manager = SessionManager.inMemory(this.#cwd);
    for (const row of rows) {
      const message = JSON.parse(row.payload_json) as AgentMessage;
      // Replay restores conversation content; pi mints fresh (ephemeral) tree ids.
      manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
    }
    return manager;
  }

  async persistEntry(sessionId: SessionId, entry: CommittedEntry): Promise<void> {
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO entries (session_id, entry_id, parent_id, payload_json, actor_id, ts) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        sessionId,
        entry.id,
        entry.parentId,
        JSON.stringify(entry.entry),
        entry.actorId ?? null,
        entry.ts,
      );
  }

  async recordBranch(): Promise<void> {}
  async recordLabel(): Promise<void> {}
  async recordCompaction(): Promise<void> {}

  async getActor(sessionId: SessionId, entryId: EntryId): Promise<string | undefined> {
    const row = this.#db
      .prepare("SELECT actor_id FROM entries WHERE session_id = ? AND entry_id = ?")
      .get<{ actor_id: string | null }>(sessionId, entryId);
    return row?.actor_id ?? undefined;
  }

  async getEntries(sessionId: SessionId): Promise<CommittedEntry[]> {
    const rows = this.#db
      .prepare(
        "SELECT entry_id, parent_id, payload_json, actor_id, ts FROM entries WHERE session_id = ? ORDER BY seq ASC",
      )
      .all<EntryRow>(sessionId);
    return rows.map((row) => ({
      id: row.entry_id as EntryId,
      parentId: (row.parent_id as EntryId | null) ?? null,
      entry: JSON.parse(row.payload_json) as unknown,
      actorId: row.actor_id ?? undefined,
      ts: row.ts,
    }));
  }

  /** Count persisted entries for a session (used by the runtime to seed its high-water). */
  count(sessionId: SessionId): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id = ?")
      .get<{ n: number }>(sessionId);
    return row?.n ?? 0;
  }
}
