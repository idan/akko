/**
 * AkkoClient — the browser-side WS + HTTP client (doc 08), as a Svelte 5 runes store.
 *
 * CQRS: HTTP creates/lists sessions; the WebSocket carries subscribe + attributed
 * commands out and events in. Reactive `$state` fields drive the UI. Uses same-origin
 * `/api` and `/ws` (Vite proxies them to the gateway in dev).
 */
import type { ClientMessage, ModelCatalogEntry, ServerMessage, SessionSummary } from "@akko/protocol";
import { WS_URL } from "./config.ts";
import {
  applyEvent,
  emptyConversation,
  markAwaiting,
  seedHistory,
  type ConversationState,
  type HistoryMessage,
  type WireEvent,
} from "./conversation.ts";

export class AkkoClient {
  readonly principalId: string;
  readonly workspaceId: string;

  connected = $state(false);
  error = $state<string | null>(null);
  sessions = $state<SessionSummary[]>([]);
  models = $state<ModelCatalogEntry[]>([]);
  activeSessionId = $state<string | null>(null);
  conversations = $state<Record<string, ConversationState>>({});

  #ws?: WebSocket;
  #subscribed = new Set<string>();
  #historyLoaded = new Set<string>();
  #cid = 0;

  constructor(opts: { principalId: string; workspaceId: string }) {
    this.principalId = opts.principalId;
    this.workspaceId = opts.workspaceId;
  }

  get activeConversation(): ConversationState {
    const id = this.activeSessionId;
    return (id && this.conversations[id]) || emptyConversation();
  }

  get activeSession(): SessionSummary | undefined {
    const id = this.activeSessionId;
    return id ? this.sessions.find((s) => s.id === id) : undefined;
  }

  connect(): void {
    // Vite's dev proxy can't relay WS upgrades under Bun, so `WS_URL` points straight at
    // the gateway in dev (cross-port is same-site, so the session cookie is still sent);
    // in prod it's same-origin (doc 16). Identity comes from the Better Auth cookie.
    const sameOrigin = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(WS_URL || sameOrigin);
    this.#ws = ws;
    ws.addEventListener("message", (e) => this.#onMessage(JSON.parse(String(e.data)) as ServerMessage));
    ws.addEventListener("close", () => {
      this.connected = false;
      // naive reconnect
      setTimeout(() => this.connect(), 1000);
    });
    ws.addEventListener("error", () => {
      this.error = "websocket error";
    });
  }

  #onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.connected = true;
        for (const id of this.#subscribed) this.#send({ t: "subscribe", sessionId: id });
        break;
      case "event": {
        const sid = msg.event.sessionId;
        // Session-metadata patches (e.g. model changes) update the session list so every
        // subscribed tab stays in sync (doc 05); other events fold into the conversation.
        if (msg.event.type === "session") {
          const patch = (msg.event as { patch: Partial<SessionSummary> }).patch;
          this.sessions = this.sessions.map((s) => (s.id === sid ? { ...s, ...patch } : s));
          break;
        }
        const prev = this.conversations[sid] ?? emptyConversation();
        this.conversations = { ...this.conversations, [sid]: applyEvent(prev, msg.event as WireEvent) };
        break;
      }
      case "error":
        this.error = msg.message;
        break;
      default:
        break;
    }
  }

  #send(msg: ClientMessage): void {
    // Guard against sending before the socket is OPEN (e.g. selecting a session while the
    // WS is still connecting). Subscriptions are replayed on `welcome`, so a dropped send
    // here is harmless.
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  async loadSessions(): Promise<void> {
    const res = await fetch(`/api/sessions?workspaceId=${encodeURIComponent(this.workspaceId)}`, {
      credentials: "include",
    });
    const data = (await res.json()) as { sessions: SessionSummary[] };
    this.sessions = data.sessions;
  }

  /** Load the available models for the workspace (doc 05) — powers the header picker. */
  async loadModels(): Promise<void> {
    const res = await fetch(`/api/models?workspaceId=${encodeURIComponent(this.workspaceId)}`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const data = (await res.json()) as { models: ModelCatalogEntry[] };
    this.models = data.models;
  }

  /** Change the active/target session's model via an attributed command (doc 05). */
  setModel(sessionId: string, model: string): void {
    this.#send({ t: "command", cid: `c${this.#cid++}`, sessionId, verb: "setModel", args: { model } });
    // Optimistic: reflect the choice immediately; the server broadcasts confirmation.
    this.sessions = this.sessions.map((s) => (s.id === sessionId ? { ...s, model } : s));
  }

  async createSession(title?: string, model?: string): Promise<void> {
    const res = await fetch(`/api/sessions`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: this.workspaceId, title: title ?? `Session ${this.sessions.length + 1}`, model }),
    });
    const data = (await res.json()) as { ref: SessionSummary };
    this.sessions = [data.ref, ...this.sessions];
    this.select(data.ref.id);
  }

  select(sessionId: string): void {
    this.activeSessionId = sessionId;
    if (!this.conversations[sessionId]) {
      this.conversations = { ...this.conversations, [sessionId]: emptyConversation() };
    }
    if (!this.#subscribed.has(sessionId)) {
      this.#subscribed.add(sessionId);
      this.#send({ t: "subscribe", sessionId });
    }
    void this.#loadHistory(sessionId);
  }

  /** Seed canonical finalized history once per session (doc 08). Live events append after. */
  async #loadHistory(sessionId: string): Promise<void> {
    if (this.#historyLoaded.has(sessionId)) return;
    this.#historyLoaded.add(sessionId);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/history`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`history ${res.status}`);
      const data = (await res.json()) as { messages: HistoryMessage[] };
      const current = this.conversations[sessionId] ?? emptyConversation();
      // Only seed if nothing has streamed in yet, so we never clobber a live turn.
      if (current.messages.length === 0) {
        this.conversations = { ...this.conversations, [sessionId]: seedHistory(current, data.messages) };
      }
    } catch {
      this.#historyLoaded.delete(sessionId); // allow a later retry
    }
  }

  sendPrompt(text: string): void {
    const sid = this.activeSessionId;
    const trimmed = text.trim();
    if (!sid || !trimmed) return;
    this.#send({ t: "command", cid: `c${this.#cid++}`, sessionId: sid, verb: "prompt", args: { text: trimmed } });
    // Optimistic "thinking" state until the assistant starts streaming.
    const conv = this.conversations[sid] ?? emptyConversation();
    this.conversations = { ...this.conversations, [sid]: markAwaiting(conv) };
  }
}