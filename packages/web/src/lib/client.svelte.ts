/**
 * AkkoClient — the browser-side command client (doc 08), as a Svelte 5 runes store.
 *
 * CQRS, post-unify (doc 15, step 3): this object only ever **writes**. Sessions are
 * created/listed over HTTP and commands are POSTed; every read — message history, the
 * in-flight turn, session titles/models — comes from the Jazz read model via reactive
 * queries in the components. There is no socket, no event stream and no client-side
 * reducer, so there is exactly one render path and one source of truth.
 *
 * Identity is the Better Auth session cookie (`credentials: "include"`); the client never
 * asserts a principal.
 */
import type { CommandVerb, ModelCatalogEntry, SessionSummary } from "@akko/protocol";

export class AkkoClient {
  readonly principalId: string;
  readonly workspaceId: string;

  error = $state<string | null>(null);
  /** Session list for the create flow; the rendered list comes from Jazz (doc 14). */
  sessions = $state<SessionSummary[]>([]);
  models = $state<ModelCatalogEntry[]>([]);
  activeSessionId = $state<string | null>(null);

  constructor(opts: { principalId: string; workspaceId: string }) {
    this.principalId = opts.principalId;
    this.workspaceId = opts.workspaceId;
  }

  get activeSession(): SessionSummary | undefined {
    const id = this.activeSessionId;
    return id ? this.sessions.find((s) => s.id === id) : undefined;
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

  async createSession(title?: string, model?: string): Promise<void> {
    const res = await fetch(`/api/sessions`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: this.workspaceId,
        title: title ?? `Session ${this.sessions.length + 1}`,
        model,
      }),
    });
    const data = (await res.json()) as { ref: SessionSummary };
    this.sessions = [data.ref, ...this.sessions];
    this.select(data.ref.id);
  }

  select(sessionId: string): void {
    this.activeSessionId = sessionId;
    // Ask the backend to backfill this session into the read model. The projection is
    // disposable (doc 04) — after a sync-server restart a session has metadata but no
    // messages — so opening it is what triggers the rebuild from canonical SQLite.
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/projection`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
  }

  /**
   * Post an attributed command. The response carries the mailbox decision (a rejection is
   * a real answer, not a failure); the *effects* arrive via the read model, so nothing
   * here updates local state optimistically — the projection is the feedback loop.
   */
  async command(sessionId: string, verb: CommandVerb, args: Record<string, unknown> = {}): Promise<void> {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/commands`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verb, args }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        this.error = body.error ?? `command failed (${res.status})`;
        return;
      }
      const { result } = (await res.json()) as { result: { accepted: boolean; reason?: string } };
      this.error = result.accepted ? null : (result.reason ?? "command rejected");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Change a session's model via an attributed command (doc 05). */
  setModel(sessionId: string, model: string): void {
    void this.command(sessionId, "setModel", { model });
    // Local echo purely so the <select> doesn't snap back before the projection lands.
    this.sessions = this.sessions.map((s) => (s.id === sessionId ? { ...s, model } : s));
  }

  /** Rename a session (doc 03). The new title arrives back via the read model. */
  rename(sessionId: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    void this.command(sessionId, "rename", { title: trimmed });
    // Local echo for the HTTP-fetched copy; the projection is the real source.
    this.sessions = this.sessions.map((s) => (s.id === sessionId ? { ...s, title: trimmed } : s));
  }

  sendPrompt(text: string): void {
    const sid = this.activeSessionId;
    const trimmed = text.trim();
    if (!sid || !trimmed) return;
    void this.command(sid, "prompt", { text: trimmed });
  }
}
