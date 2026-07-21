/**
 * AkkoClient — the browser-side WS + HTTP client (doc 08), as a Svelte 5 runes store.
 *
 * CQRS: HTTP creates/lists sessions; the WebSocket carries subscribe + attributed
 * commands out and events in. Reactive `$state` fields drive the UI. Uses same-origin
 * `/api` and `/ws` (Vite proxies them to the gateway in dev).
 */
import type { ClientMessage, ServerMessage, SessionSummary } from "@akko/protocol";
import { applyEvent, emptyConversation, type ConversationState, type WireEvent } from "./conversation.ts";

export class AkkoClient {
  readonly principalId: string;
  readonly workspaceId: string;

  connected = $state(false);
  error = $state<string | null>(null);
  sessions = $state<SessionSummary[]>([]);
  activeSessionId = $state<string | null>(null);
  conversations = $state<Record<string, ConversationState>>({});
  /** Jazz projection CoValue id per session (doc 14), when the backend projector is on. */
  jazzIds = $state<Record<string, string>>({});

  #ws?: WebSocket;
  #subscribed = new Set<string>();
  #cid = 0;

  constructor(opts: { principalId: string; workspaceId: string }) {
    this.principalId = opts.principalId;
    this.workspaceId = opts.workspaceId;
  }

  get activeConversation(): ConversationState {
    const id = this.activeSessionId;
    return (id && this.conversations[id]) || emptyConversation();
  }

  get activeJazzId(): string | undefined {
    const id = this.activeSessionId;
    return id ? this.jazzIds[id] : undefined;
  }

  #rememberJazz(refs: SessionSummary[]): void {
    const next = { ...this.jazzIds };
    for (const r of refs) if (r.jazzId) next[r.id] = r.jazzId;
    this.jazzIds = next;
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?principal=${encodeURIComponent(this.principalId)}`);
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
    this.#ws?.send(JSON.stringify(msg));
  }

  async loadSessions(): Promise<void> {
    const res = await fetch(`/api/sessions?workspaceId=${encodeURIComponent(this.workspaceId)}`, {
      headers: { "x-akko-principal": this.principalId },
    });
    const data = (await res.json()) as { sessions: SessionSummary[] };
    this.sessions = data.sessions;
    this.#rememberJazz(data.sessions);
  }

  async createSession(title?: string): Promise<void> {
    const res = await fetch(`/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-akko-principal": this.principalId },
      body: JSON.stringify({ workspaceId: this.workspaceId, title: title ?? `Session ${this.sessions.length + 1}` }),
    });
    const data = (await res.json()) as { ref: SessionSummary };
    this.sessions = [data.ref, ...this.sessions];
    this.#rememberJazz([data.ref]);
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
  }

  sendPrompt(text: string): void {
    const sid = this.activeSessionId;
    const trimmed = text.trim();
    if (!sid || !trimmed) return;
    this.#send({ t: "command", cid: `c${this.#cid++}`, sessionId: sid, verb: "prompt", args: { text: trimmed } });
  }
}