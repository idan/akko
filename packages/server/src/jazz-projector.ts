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
 *    (`act_<sessionId>`), retired to `kind: "idle"` when the finalized message lands.
 *
 * The activity row is **never deleted**: Jazz deletes are tombstones, and re-`upsert`ing a
 * deleted id fails permanently (`WriteError: row already deleted`) — which would make the
 * live indicator work on a session's first turn and never again. Retiring to `idle`
 * (which the UI renders as nothing) keeps the id reusable for every subsequent turn.
 *
 * This is what makes the Jazz view feel as live as the WS. Jazz is never the source of
 * truth — canonical content is SQLite (doc 04). Every Jazz write is wrapped so a
 * projection failure can never propagate into the event bus / runtime; set
 * `AKKO_JAZZ_DEBUG=1` for verbose tracing.
 */
import type { Db } from "jazz-tools/backend";
import { createHash } from "node:crypto";
import { app, describeToolCall, textOfContent, toolCallsOfContent } from "@akko/schema";
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
  assistantMessageEvent?: {
    type: string;
    delta?: string;
    toolCall?: { name: string; arguments?: Record<string, unknown> };
  };
}

interface TurnState {
  userText: string;
  text: string;
  /** Description of the tool currently running, shown while `kind: "tool"`. */
  toolLabel?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface JazzProjectorDeps {
  /** Live pi event stream — drives the ephemeral `activity` row. */
  eventBus?: EventBus;
  /**
   * Canonical entries for a session, used to **backfill** the projection (doc 04: the
   * read model must be recreatable from canonical storage). Without this, a session's
   * history is missing from Jazz whenever the projection is lost — e.g. every restart of
   * an `--in-memory` sync server, or a session rehydrated on a node that never saw it.
   */
  getEntries?: (sessionId: SessionId) => Promise<CommittedEntry[]>;
}

/** Stable Jazz ObjectId (UUID form) from arbitrary key material. */
function stableId(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const activityId = (sessionId: SessionId): string => stableId(`activity:${sessionId}`);
const sessionRowId = (sessionId: SessionId): string => stableId(`session:${sessionId}`);
/** Deterministic row id per canonical entry — makes projection idempotent (upsert-safe). */
const messageRowId = (sessionId: SessionId, entryId: string): string =>
  stableId(`message:${sessionId}:${entryId}`);

export class JazzProjector implements SessionProjector {
  readonly #db: Db;
  readonly #eventBus?: EventBus;
  readonly #getEntries?: (sessionId: SessionId) => Promise<CommittedEntry[]>;
  #projected = new Set<SessionId>();
  #workspaceOf = new Map<SessionId, string>();
  #subs = new Map<SessionId, () => void>();
  #turn = new Map<SessionId, TurnState>();
  #active = new Set<SessionId>();
  #backfilled = new Set<SessionId>();

  constructor(db: Db, deps: JazzProjectorDeps = {}) {
    this.#db = db;
    this.#eventBus = deps.eventBus;
    this.#getEntries = deps.getEntries;
  }

  ensureSession(ref: SessionRef): string {
    this.#projected.add(ref.id);
    this.#workspaceOf.set(ref.id, ref.workspaceId);
    // Project the session row itself (doc 02) so the session list is reactive across
    // tabs/devices/members. Upsert-safe + never deleted, so this is cheap to re-run and
    // doubles as the "metadata changed" refresh (e.g. after setModel).
    this.#projectSession(ref);
    if (this.#eventBus && !this.#subs.has(ref.id)) {
      this.#subs.set(
        ref.id,
        this.#eventBus.subscribe(ref.id, (event) => this.#onLiveEvent(ref.id, event)),
      );
      debug("subscribed", ref.id, "workspace", ref.workspaceId);
    }
    // Backfill canonical history once per session, so the Jazz view shows prior messages
    // (the projection is otherwise only built forward from live entries).
    if (!this.#backfilled.has(ref.id)) {
      this.#backfilled.add(ref.id);
      void this.rebuild(ref.id);
    }
    return ref.id;
  }

  projectionId(sessionId: SessionId): string | undefined {
    return this.#projected.has(sessionId) ? sessionId : undefined;
  }

  /** Project a session's metadata only — no history backfill, no live subscription. */
  projectSessionMeta(ref: SessionRef): void {
    this.#workspaceOf.set(ref.id, ref.workspaceId);
    this.#projectSession(ref);
  }

  /** Upsert the session's metadata row. Never deleted (Jazz deletes tombstone the id). */
  #projectSession(ref: SessionRef): void {
    try {
      this.#db.upsert(
        app.sessions,
        {
          sessionId: ref.id,
          workspaceId: ref.workspaceId,
          ownerId: ref.ownerId,
          kind: ref.kind,
          title: ref.title ?? "",
          model: ref.model ?? "",
          createdAt: new Date(ref.createdAt),
          updatedAt: new Date(ref.updatedAt),
        },
        { id: sessionRowId(ref.id) },
      );
      debug("session row", ref.id, `title="${ref.title ?? ""}" model="${ref.model ?? ""}"`);
    } catch (error) {
      console.error(`[jazz] failed to project session ${ref.id}:`, error);
    }
  }

  async onEntry(sessionId: SessionId, entry: CommittedEntry): Promise<void> {
    const projected = this.#projectEntry(sessionId, entry);
    // The finalized assistant message now lives in `messages`; retire the live bubble.
    if (projected === "assistant") this.#clearActivity(sessionId);
  }

  /** Upsert one canonical entry as a `messages` row. Returns the role, or undefined if skipped. */
  #projectEntry(sessionId: SessionId, entry: CommittedEntry): "user" | "assistant" | undefined {
    const message = entry.entry as { role?: string; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") return undefined;

    const text = textOfContent(message.content);
    // An assistant message that only calls tools has no text. Projecting it verbatim
    // produced empty chat bubbles (one per tool call — very visible with subagents), so
    // render it as what it is: a record of tool use. `role` is a free-form string column,
    // so "tool" needs no schema change.
    const tools = text ? "" : toolCallsOfContent(message.content);
    if (!text && !tools) return message.role; // nothing to show; don't create an empty row

    try {
      // Deterministic id keyed on the canonical entry => idempotent, so re-projecting
      // (backfill after a projection loss) can never duplicate rows.
      this.#db.upsert(
        app.messages,
        {
          sessionId,
          workspaceId: this.#workspaceOf.get(sessionId) ?? "",
          role: tools ? "tool" : message.role,
          text: text || tools,
          createdAt: new Date(entry.ts),
          authorId: entry.actorId ?? "",
        },
        { id: messageRowId(sessionId, entry.id) },
      );
    } catch (error) {
      console.error(`[jazz] failed to project message for ${sessionId}:`, error);
    }
    return message.role;
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
        case "message_update": {
          const ev = pi.assistantMessageEvent;
          if (ev?.type === "text_delta" && ev.delta) {
            this.#appendStream(sessionId, ev.delta);
          } else if (ev?.type === "toolcall_end" && ev.toolCall) {
            // A tool is about to run. Blocking tools (notably spawn_subagent) can take
            // minutes, during which the turn produces no tokens — without this the UI
            // shows a stale streaming bubble and looks hung.
            const t = this.#turn.get(sessionId) ?? { userText: "", text: "" };
            t.toolLabel = describeToolCall(ev.toolCall);
            this.#turn.set(sessionId, t);
            debug("tool start", sessionId, t.toolLabel);
            this.#writeActivity(sessionId, "tool");
          }
          break;
        }
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
    t.toolLabel = undefined; // tokens are flowing again — the tool phase is over
    t.text += delta;
    if (!t.timer) {
      t.timer = setTimeout(() => {
        t.timer = undefined;
        this.#writeActivity(sessionId, "streaming");
      }, STREAM_FLUSH_MS);
    }
    this.#turn.set(sessionId, t);
  }

  #writeActivity(sessionId: SessionId, kind: "thinking" | "streaming" | "tool" | "idle"): void {
    const t = this.#turn.get(sessionId) ?? { userText: "", text: "" };
    try {
      this.#db.upsert(
        app.activity,
        {
          sessionId,
          workspaceId: this.#workspaceOf.get(sessionId) ?? "",
          kind,
          userText: t.userText,
          // While a tool runs there is no streaming text; show what it is doing instead.
          text: kind === "tool" ? (t.toolLabel ?? "") : t.text,
          updatedAt: new Date(),
        },
        { id: activityId(sessionId) },
      );
      this.#active.add(sessionId);
    } catch (error) {
      console.error(`[jazz] failed to write activity for ${sessionId}:`, error);
    }
  }

  /**
   * Retire the live bubble. Writes `kind: "idle"` rather than deleting: a Jazz delete is a
   * tombstone and the id could never be reused, breaking every turn after the first.
   */
  #clearActivity(sessionId: SessionId): void {
    const t = this.#turn.get(sessionId);
    if (t?.timer) clearTimeout(t.timer);
    this.#turn.delete(sessionId);
    if (this.#active.has(sessionId)) {
      this.#turn.set(sessionId, { userText: "", text: "" });
      this.#writeActivity(sessionId, "idle");
      this.#turn.delete(sessionId);
      debug("activity idled", sessionId);
      this.#active.delete(sessionId);
    }
  }

  /**
   * Rebuild the projection for a session from canonical storage (doc 04). Idempotent:
   * rows are keyed by a deterministic id per entry, so this can run any time — on first
   * sight of a session, after a projection loss (e.g. an in-memory sync server restart),
   * or when a session is rehydrated on a node that never projected it.
   */
  async rebuild(sessionId: SessionId): Promise<void> {
    if (!this.#getEntries) return;
    try {
      const entries = await this.#getEntries(sessionId);
      let n = 0;
      for (const entry of entries) if (this.#projectEntry(sessionId, entry)) n++;
      if (n > 0) debug("backfilled", sessionId, `${n} message(s)`);
    } catch (error) {
      console.error(`[jazz] failed to rebuild projection for ${sessionId}:`, error);
    }
  }

  async drop(sessionId: SessionId): Promise<void> {
    this.#subs.get(sessionId)?.();
    this.#subs.delete(sessionId);
    this.#clearActivity(sessionId);
    this.#projected.delete(sessionId);
    this.#workspaceOf.delete(sessionId);
    this.#backfilled.delete(sessionId);
  }
}
