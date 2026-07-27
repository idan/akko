/**
 * JazzProjector — projects the conversation into the Jazz read model (doc 14/08).
 *
 * Two projections, from two feeds:
 *  - **`messages`** (finalized, source-recreatable): each committed entry (`onEntry`,
 *    fed by the runtime's entry sinks) becomes one row. Insert-only.
 *  - **`activity`** (ephemeral, disposable): the assistant's in-flight turn. Derived from
 *    the live pi event stream on the `EventBus` — a "thinking" row when a turn starts,
 *    then "streaming" with a throttled, growing `text`. Exactly one row per session
 *    (`act_<sessionId>`), deleted when the finalized message lands in `messages`.
 *
 * This is what makes the Jazz view feel as live as the WS: the frontend renders finalized
 * `messages` plus the ephemeral `activity` (thinking indicator + streaming bubble). Jazz
 * is never the source of truth — canonical content is SQLite (doc 04). The projector is
 * just another subscriber to the same event stream the WS gateway consumes, which is the
 * shape we want if Jazz later becomes the *sole* read model.
 */
import type { Db } from "jazz-tools/backend";
import { createHash } from "node:crypto";
import { app, textOfContent } from "@akko/schema";
import type { CommittedEntry, DomainEvent, EventBus, SessionId, SessionRef } from "@akko/core";
import type { SessionProjector } from "@akko/runtime";

/** How often (ms) streamed text is flushed to the `activity` row — trades smoothness vs. write volume. */
const STREAM_FLUSH_MS = 100;

/** The subset of a pi streaming event this projector reads (kept loose to avoid pi type coupling). */
interface PiEvent {
  type: string;
  message?: { role?: string; content?: unknown };
  assistantMessageEvent?: { type: string; delta?: string };
}

interface StreamState {
  text: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** Stable Jazz ObjectId (UUID form) for a session's single ephemeral `activity` row. */
function activityId(sessionId: SessionId): string {
  const h = createHash("sha256").update(`activity:${sessionId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export class JazzProjector implements SessionProjector {
  readonly #db: Db;
  readonly #eventBus?: EventBus;
  #projected = new Set<SessionId>();
  #workspaceOf = new Map<SessionId, string>();
  #subs = new Map<SessionId, () => void>();
  #stream = new Map<SessionId, StreamState>();
  #active = new Set<SessionId>(); // sessions with a live `activity` row

  constructor(db: Db, eventBus?: EventBus) {
    this.#db = db;
    this.#eventBus = eventBus;
  }

  /** Mark a session projected; subscribe to its live event stream for `activity`. */
  ensureSession(ref: SessionRef): string {
    this.#projected.add(ref.id);
    this.#workspaceOf.set(ref.id, ref.workspaceId);
    if (this.#eventBus && !this.#subs.has(ref.id)) {
      this.#subs.set(
        ref.id,
        this.#eventBus.subscribe(ref.id, (event) => this.#onLiveEvent(ref.id, event)),
      );
    }
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

    // The finalized assistant message now lives in `messages`; retire the live bubble.
    if (message.role === "assistant") this.#clearActivity(sessionId);
  }

  /** Derive the ephemeral `activity` row from the live pi event stream. */
  #onLiveEvent(sessionId: SessionId, event: DomainEvent): void {
    if (event.type !== "pi") return;
    const pi = (event as { event?: PiEvent }).event;
    if (!pi) return;

    switch (pi.type) {
      case "message_start":
        if (pi.message?.role === "user") {
          // Turn starting; the assistant is thinking until it streams.
          this.#setActivity(sessionId, "thinking", "");
        } else if (pi.message?.role === "assistant") {
          this.#stream.set(sessionId, { text: "" });
          this.#setActivity(sessionId, "streaming", "");
        }
        break;
      case "message_update":
        if (pi.assistantMessageEvent?.type === "text_delta" && pi.assistantMessageEvent.delta) {
          this.#appendStream(sessionId, pi.assistantMessageEvent.delta);
        }
        break;
      case "turn_end":
      case "agent_end":
        // Safety net: clear a lingering "thinking" row for a turn that produced no message.
        this.#clearActivity(sessionId);
        break;
    }
  }

  #appendStream(sessionId: SessionId, delta: string): void {
    const s = this.#stream.get(sessionId) ?? { text: "" };
    s.text += delta;
    if (!s.timer) {
      s.timer = setTimeout(() => {
        s.timer = undefined;
        this.#setActivity(sessionId, "streaming", s.text);
      }, STREAM_FLUSH_MS);
    }
    this.#stream.set(sessionId, s);
  }

  #setActivity(sessionId: SessionId, kind: "thinking" | "streaming", text: string): void {
    this.#db.upsert(
      app.activity,
      { sessionId, workspaceId: this.#workspaceOf.get(sessionId) ?? "", kind, text, updatedAt: new Date() },
      { id: activityId(sessionId) },
    );
    this.#active.add(sessionId);
  }

  #clearActivity(sessionId: SessionId): void {
    const s = this.#stream.get(sessionId);
    if (s?.timer) clearTimeout(s.timer);
    this.#stream.delete(sessionId);
    if (this.#active.has(sessionId)) {
      this.#db.delete(app.activity, activityId(sessionId));
      this.#active.delete(sessionId);
    }
  }

  async rebuild(_sessionId: SessionId): Promise<void> {
    // Slice: projection is built forward from live entries. Rebuild-from-store is later.
  }

  async drop(sessionId: SessionId): Promise<void> {
    this.#subs.get(sessionId)?.();
    this.#subs.delete(sessionId);
    this.#clearActivity(sessionId);
    this.#projected.delete(sessionId);
    this.#workspaceOf.delete(sessionId);
  }
}
