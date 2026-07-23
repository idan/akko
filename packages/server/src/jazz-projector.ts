/**
 * JazzProjector — projects committed conversation entries into the Jazz `messages`
 * table (doc 14). A `SessionProjector` (sibling read-model sink, doc 04): each finalized
 * message becomes a row keyed by `sessionId`. It is NOT the source of truth — canonical
 * content lives in SQLite (doc 04). Live token streaming stays on the WS.
 *
 * Constructed with a backend `Db` (from `createBackendDb`, connected to the sync
 * server). Reads are gated by the `messages` row policy (doc 16): a client may read only
 * rows whose `workspaceId` matches its verified JWT claim. The backend writes with a
 * privileged secret that bypasses policies.
 */
import type { Db } from "jazz-tools/backend";
import { app, textOfContent } from "@akko/schema";
import type { CommittedEntry, SessionId, SessionRef } from "@akko/core";
import type { SessionProjector } from "@akko/runtime";

export class JazzProjector implements SessionProjector {
  readonly #db: Db;
  #projected = new Set<SessionId>();
  #workspaceOf = new Map<SessionId, string>();

  constructor(db: Db) {
    this.#db = db;
  }

  /** Mark a session projected. In the relational model the key is the sessionId itself. */
  ensureSession(ref: SessionRef): string {
    this.#projected.add(ref.id);
    this.#workspaceOf.set(ref.id, ref.workspaceId);
    return ref.id;
  }

  projectionId(sessionId: SessionId): string | undefined {
    return this.#projected.has(sessionId) ? sessionId : undefined;
  }

  async onEntry(sessionId: SessionId, entry: CommittedEntry): Promise<void> {
    const message = entry.entry as { role?: string; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") return;

    this.#db.insert(app.messages, {
      sessionId,
      workspaceId: this.#workspaceOf.get(sessionId) ?? "",
      role: message.role,
      text: textOfContent(message.content),
      createdAt: new Date(entry.ts),
      authorId: entry.actorId ?? "",
    });
  }

  async rebuild(_sessionId: SessionId): Promise<void> {
    // Slice: projection is built forward from live entries. Rebuild-from-store is later.
  }

  async drop(sessionId: SessionId): Promise<void> {
    this.#projected.delete(sessionId);
    this.#workspaceOf.delete(sessionId);
  }
}