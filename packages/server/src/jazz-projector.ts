/**
 * JazzProjector — projects committed conversation entries into Jazz CoValues (doc 14).
 *
 * A `SessionProjector` (sibling read-model sink, doc 04): on each committed entry it
 * appends a `Message` CoMap to the session's `Conversation` CoList. It is NOT the source
 * of truth — canonical content lives in SQLite (doc 04). Live token streaming stays on
 * the WS; only finalized messages arrive here (they are what `SessionRuntime` captures).
 *
 * Requires the worker account to be the active Jazz account (set by `startWorker`
 * `asActiveAccount`, or `createJazzTestAccount({ isCurrentActiveAccount: true })`).
 */
import { co, Group } from "jazz-tools";
import { Conversation, Message, textOfContent } from "@akko/schema";
import type { CommittedEntry, SessionId, SessionRef } from "@akko/core";
import type { SessionProjector } from "@akko/runtime";

type JazzGroup = ReturnType<typeof Group.create>;
function createMessageList(group: JazzGroup) {
  return co.list(Message).create([], group);
}
type MessageList = ReturnType<typeof createMessageList>;

interface ProjectedSession {
  id: string;
  group: JazzGroup;
  messages: MessageList;
}

export class JazzProjector implements SessionProjector {
  #sessions = new Map<SessionId, ProjectedSession>();
  readonly #publicRead: boolean;

  constructor(options?: { publicRead?: boolean }) {
    // Slice default: public read so a dev/guest client can render without full auth (doc 14).
    this.#publicRead = options?.publicRead ?? true;
  }

  ensureSession(ref: SessionRef): string {
    const existing = this.#sessions.get(ref.id);
    if (existing) return existing.id;

    const group = Group.create();
    if (this.#publicRead) group.addMember("everyone", "reader");

    const messages = createMessageList(group);
    const convo = Conversation.create(
      { sessionId: ref.id, title: ref.title ?? "Session", messages },
      group,
    );
    const id = convo.$jazz.id;
    this.#sessions.set(ref.id, { id, group, messages });
    return id;
  }

  projectionId(sessionId: SessionId): string | undefined {
    return this.#sessions.get(sessionId)?.id;
  }

  async onEntry(sessionId: SessionId, entry: CommittedEntry): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    const message = entry.entry as { role?: string; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") return;

    session.messages.$jazz.push(
      Message.create(
        {
          role: message.role,
          text: textOfContent(message.content),
          createdAt: entry.ts,
          authorId: entry.actorId,
        },
        session.group,
      ),
    );
  }

  async rebuild(_sessionId: SessionId): Promise<void> {
    // Slice: projection is built forward from live entries. Rebuild-from-store is later.
  }

  async drop(sessionId: SessionId): Promise<void> {
    this.#sessions.delete(sessionId);
  }
}