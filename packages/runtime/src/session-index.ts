/**
 * SessionIndex — the durable "our DB" layer for session metadata (doc 04).
 *
 * Holds `SessionRef` rows for fast, ACL-filterable listing and for rehydration lookups
 * (session -> workspace/owner), independent of pi's conversation content. Two
 * implementations: `InMemorySessionIndex` (default, tests) and `SqliteSessionIndex`
 * (durable, via `SqliteAdapter`).
 */
import type {
  SessionId,
  SessionKind,
  SessionRef,
  SqliteAdapter,
  WorkspaceId,
} from "@akko/core";

export interface SessionIndex {
  upsertRef(ref: SessionRef): void;
  getRef(id: SessionId): SessionRef | undefined;
  listRefs(workspaceId: WorkspaceId): SessionRef[];
  touch(id: SessionId, updatedAt: number): void;
}

export class InMemorySessionIndex implements SessionIndex {
  #refs = new Map<SessionId, SessionRef>();

  upsertRef(ref: SessionRef): void {
    this.#refs.set(ref.id, { ...ref });
  }
  getRef(id: SessionId): SessionRef | undefined {
    const ref = this.#refs.get(id);
    return ref ? { ...ref } : undefined;
  }
  listRefs(workspaceId: WorkspaceId): SessionRef[] {
    return [...this.#refs.values()].filter((r) => r.workspaceId === workspaceId);
  }
  touch(id: SessionId, updatedAt: number): void {
    const ref = this.#refs.get(id);
    if (ref) ref.updatedAt = updatedAt;
  }
}

interface SessionRow {
  id: string;
  workspace_id: string;
  owner_id: string;
  kind: string;
  parent_session_id: string | null;
  title: string | null;
  model: string | null;
  host_node: string | null;
  created_at: number;
  updated_at: number;
}

export class SqliteSessionIndex implements SessionIndex {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                TEXT PRIMARY KEY,
        workspace_id      TEXT NOT NULL,
        owner_id          TEXT NOT NULL,
        kind              TEXT NOT NULL,
        parent_session_id TEXT,
        title             TEXT,
        model             TEXT,
        host_node         TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
    `);
    // Migration for DBs created before the model column existed (doc 05).
    const hasModel = this.#db
      .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('sessions') WHERE name = 'model'")
      .get<{ n: number }>();
    if (!hasModel || hasModel.n === 0) this.#db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
  }

  upsertRef(ref: SessionRef): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (id, workspace_id, owner_id, kind, parent_session_id, title, model, host_node, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, owner_id=excluded.owner_id, kind=excluded.kind,
           parent_session_id=excluded.parent_session_id, title=excluded.title, model=excluded.model,
           host_node=excluded.host_node, updated_at=excluded.updated_at`,
      )
      .run(
        ref.id,
        ref.workspaceId,
        ref.ownerId,
        ref.kind,
        ref.parentSessionId ?? null,
        ref.title ?? null,
        ref.model ?? null,
        ref.hostNode ?? null,
        ref.createdAt,
        ref.updatedAt,
      );
  }

  getRef(id: SessionId): SessionRef | undefined {
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get<SessionRow>(id);
    return row ? this.#toRef(row) : undefined;
  }

  listRefs(workspaceId: WorkspaceId): SessionRef[] {
    return this.#db
      .prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC")
      .all<SessionRow>(workspaceId)
      .map((row) => this.#toRef(row));
  }

  touch(id: SessionId, updatedAt: number): void {
    this.#db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(updatedAt, id);
  }

  #toRef(row: SessionRow): SessionRef {
    return {
      id: row.id as SessionId,
      workspaceId: row.workspace_id as WorkspaceId,
      ownerId: row.owner_id as SessionRef["ownerId"],
      kind: row.kind as SessionKind,
      parentSessionId: (row.parent_session_id ?? undefined) as SessionRef["parentSessionId"],
      title: row.title ?? undefined,
      model: row.model ?? undefined,
      hostNode: (row.host_node ?? undefined) as SessionRef["hostNode"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
