/**
 * JazzProjector — projects the conversation into the Jazz read model (doc 14/08).
 *
 * Two projections, from two feeds:
 *  - **`messages`** (finalized, source-recreatable): each committed entry (`onEntry`,
 *    fed by the runtime's entry sinks) becomes one row. Insert-only.
 *  - **`activity`** (ephemeral, disposable): the in-flight turn. Derived from the live pi
 *    event stream on the `EventBus` — the user's prompt (shown immediately, since
 *    canonical entries are only captured at turn end), a "thinking" indicator, then a
 *    "streaming" assistant bubble with throttled growing `text`. One row per session
 *    (`act_<sessionId>`), deleted when the finalized message lands in `messages`.
 *
 * This is what makes the Jazz view feel as live as the WS. Jazz is never the source of
 * truth — canonical content is SQLite (doc 04). Every Jazz write is wrapped so a
 * projection failure can never propagate into the event bus / runtime; set
 * `AKKO_JAZZ_DEBUG=1` for verbose tracing.
 */
import type { Db } from "jazz-tools/backend";
import { createHash } from "node:crypto";
import { app, textOfContent } from "@akko/schema";
import type { CommittedEntry, DomainEvent, EventBus, SessionId, SessionRef } from "@akko/core";
import type { SessionProjector } from "@akko/runtime";

/** How often (ms) streamed text is flushed to the `activity` row — smoothness vs. write volume. */
const STREAM_FLUSH_MS = 40;

const DEBUG = process.env.AKKO_JAZZ_DEBUG === "1";
const debug = (...args: unknown[]): void => {
  if (DEBUG) console.log("[jazz]", ...args);
};

interface PiEvent {
  type: string;
  message?: { role?: string; content?: unknown };
  assistantMessageEvent?: { type: string; delta?: string };
}

interface TurnState {
  userText: string;
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
  #turn = new Map<SessionId, TurnState>();
  #active = new Set<SessionId>();

  constructor(db: Db, eventBus?: EventBus) {
    this.#db = db;
    this.#eventBus = eventBus;
  }

  ensureSession(ref: SessionRef): string {
    this.#projected.add(ref.id);
    this.#workspaceOf.set(ref.id, ref.workspaceId);
    if (this.#eventBus && !this.#subs.has(ref.id)) {
      this.#subs.set(
        ref.id,
        this.#eventBus.subscribe(ref.id, (event) => this.#onLiveEvent(ref.id, event)),
      );
      debug("subscribed", ref.id, "workspace", ref.workspaceId);
    }
    return ref.id;
  }

  projectionId(sessionId: SessionId): string | undefined {
    return this.#projected.has(sessionId) ? sessionId : undefined;
  }

  async onEntry(sessionId: SessionId, entry: CommittedEntry): Promise<void> {
    const message = entry.entry as { role?: string; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") return;
    try {
      this.#db.insert(app.messages, {
        sessionId,
        workspaceId: this.#workspaceOf.get(sessionId) ?? "",
        role: message.role,
        text: textOfContent(message.content),
        createdAt: new Date(entry.ts),
        authorId: entry.actorId ?? "",
      });
      debug("message row", sessionId, message.role, `"${textOfContent(message.content).slice(0, 40)}"`);
    } catch (error) {
      console.error(`[jazz] failed to project message for ${sessionId}:`, error);
    }
    // The finalized assistant message now lives in `messages`; retire the live bubble.
    if (message.role === "assistant") this.#clearActivity(sessionId);
  }

  /** Derive the ephemeral `activity` row from the live pi event stream. Never throws. */
  #onLiveEvent(sessionId: SessionId, event: DomainEvent): void {
    try {
      if (event.type !== "pi") return;
      const pi = (event as { event?: PiEvent }).event;
      if (!pi) return;

      switch (pi.type) {
        case "message_start":
          if (pi.message?.role === "user") {
            const userText = textOfContent(pi.message.content);
            this.#turn.set(sessionId, { userText, text: "" });
            debug("thinking", sessionId, `user="${userText.slice(0, 40)}"`);
            this.#writeActivity(sessionId, "thinking");
          } else if (pi.message?.role === "assistant") {
            const t = this.#turn.get(sessionId) ?? { userText: "", text: "" };
            t.text = "";
            this.#turn.set(sessionId, t);
            debug("streaming start", sessionId);
            this.#writeActivity(sessionId, "streaming");
          }
          break;
        case "message_update":
          if (pi.assistantMessageEvent?.type === "text_delta" && pi.assistantMessageEvent.delta) {
            this.#appendStream(sessionId, pi.assistantMessageEvent.delta);
          }
          break;
        case "turn_end":
        case "agent_end":
          debug("turn end", sessionId);
          this.#clearActivity(sessionId);
          break;
      }
    } catch (error) {
      console.error(`[jazz] live-event handler failed for ${sessionId}:`, error);
    }
  }

  #appendStream(sessionId: SessionId, delta: string): void {
    const t = this.#turn.get(sessionId) ?? { userText: "", text: "" };
    t.text += delta;
    if (!t.timer) {
      t.timer = setTimeout(() => {
        t.timer = undefined;
        this.#writeActivity(sessionId, "streaming");
      }, STREAM_FLUSH_MS);
    }
    this.#turn.set(sessionId, t);
  }

  #writeActivity(sessionId: SessionId, kind: "thinking" | "streaming"): void {
    const t = this.#turn.get(sessionId) ?? { userText: "", text: "" };
    try {
      this.#db.upsert(
        app.activity,
        {
          sessionId,
          workspaceId: this.#workspaceOf.get(sessionId) ?? "",
          kind,
          userText: t.userText,
          text: t.text,
          updatedAt: new Date(),
        },
        { id: activityId(sessionId) },
      );
      this.#active.add(sessionId);
    } catch (error) {
      console.error(`[jazz] failed to write activity for ${sessionId}:`, error);
    }
  }

  #clearActivity(sessionId: SessionId): void {
    const t = this.#turn.get(sessionId);
    if (t?.timer) clearTimeout(t.timer);
    this.#turn.delete(sessionId);
    if (this.#active.has(sessionId)) {
      try {
        this.#db.delete(app.activity, activityId(sessionId));
        debug("activity cleared", sessionId);
      } catch (error) {
        console.error(`[jazz] failed to clear activity for ${sessionId}:`, error);
      }
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
