/**
 * InMemoryConversationStore — slice-1 `ConversationStore` (doc 04).
 *
 * Backs each session with pi's `SessionManager.inMemory()` (the tree lives in RAM) and
 * keeps the attribution side-table (`actorId` per entry) in a map. This satisfies the
 * durable/canonical seam without file I/O so the runtime + registry can be built and
 * tested now; the JSONL-canonical and SQLite-canonical implementations (doc 04, routes
 * 1 and 3) slot in behind the same interface later.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  CommittedEntry,
  ConversationStore,
  EntryId,
  SessionId,
} from "@akko/core";

export class InMemoryConversationStore implements ConversationStore {
  #managers = new Map<SessionId, SessionManager>();
  #actors = new Map<string, string>(); // `${sessionId}:${entryId}` -> actorId
  #entries = new Map<SessionId, CommittedEntry[]>();
  readonly #cwd: string;

  constructor(options?: { cwd?: string }) {
    this.#cwd = options?.cwd ?? process.cwd();
  }

  async create(sessionId: SessionId): Promise<SessionManager> {
    const manager = SessionManager.inMemory(this.#cwd);
    this.#managers.set(sessionId, manager);
    return manager;
  }

  async load(sessionId: SessionId): Promise<SessionManager> {
    const manager = this.#managers.get(sessionId);
    if (!manager) throw new Error(`session not found in store: ${sessionId}`);
    return manager;
  }

  async persistEntry(sessionId: SessionId, entry: CommittedEntry): Promise<void> {
    // Content already lives in the in-memory SessionManager tree; record attribution.
    if (entry.actorId) this.#actors.set(`${sessionId}:${entry.id}`, entry.actorId);
    const list = this.#entries.get(sessionId) ?? [];
    list.push(entry);
    this.#entries.set(sessionId, list);
  }

  async recordBranch(): Promise<void> {}
  async recordLabel(): Promise<void> {}
  async recordCompaction(): Promise<void> {}

  async getActor(sessionId: SessionId, entryId: EntryId): Promise<string | undefined> {
    return this.#actors.get(`${sessionId}:${entryId}`);
  }

  async getEntries(sessionId: SessionId): Promise<CommittedEntry[]> {
    return [...(this.#entries.get(sessionId) ?? [])];
  }
}
