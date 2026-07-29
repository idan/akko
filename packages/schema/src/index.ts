/**
 * @akko/schema — Jazz 2.0 relational schema (doc 14).
 *
 * Jazz 2.0 is a local-first relational database (tables + SQL-like queries), not the
 * 0.x CoValue/CRDT model. The projected conversation is a `messages` table keyed by
 * `sessionId` — a near 1:1 shape with our canonical SQLite (doc 04). It is a
 * *projection*, never the source of truth; live token streaming stays on the WS and
 * only finalized messages are projected here.
 *
 * The same `app` is imported by the backend (to insert) and the frontend (to query),
 * so they share one schema.
 */
import { schema as s } from "jazz-tools";

export const appSchema = {
  messages: s.table({
    sessionId: s.string(),
    /** Workspace that owns the session — the read-ACL key (doc 16). */
    workspaceId: s.string(),
    role: s.string(),
    text: s.string(),
    createdAt: s.timestamp(),
    /** Attribution: principal id for user messages; "" for agent output (doc 04). */
    authorId: s.string(),
  }),
  /**
   * Session metadata (doc 02) — the reactive session list. Mirrors `SessionRef` from our
   * canonical index; one row per session, keyed by a derived id so it is upsert-safe.
   * Projecting this is what makes the session list live across tabs, devices and members
   * without any socket fan-out.
   */
  sessions: s.table({
    sessionId: s.string(),
    /** Workspace that owns the session — the read-ACL key (doc 16). */
    workspaceId: s.string(),
    ownerId: s.string(),
    kind: s.string(),
    title: s.string(),
    /** Resolved `provider/id` for the session's model (doc 05); "" when unset. */
    model: s.string(),
    createdAt: s.timestamp(),
    updatedAt: s.timestamp(),
  }),
  /**
   * Ephemeral live state (doc 08): the assistant's in-flight turn — "thinking" before it
   * streams, then "streaming" with a growing `text`. Exactly one row per session (id =
   * `act_<sessionId>`), upserted during a turn and deleted when the finalized message
   * lands in `messages`. This is the disposable, recreatable projection that makes the
   * Jazz view feel live; it is never a source of truth.
   */
  activity: s.table({
    sessionId: s.string(),
    workspaceId: s.string(),
    /** "thinking" | "streaming". */
    kind: s.string(),
    /** The in-flight user prompt — shown immediately (canonical rows are only captured at
     * turn end), so the sender's message doesn't wait for the assistant to finish. */
    userText: s.string(),
    /** In-flight assistant text (empty while thinking). */
    text: s.string(),
    updatedAt: s.timestamp(),
  }),
};

export const app = s.defineApp(appSchema);

/**
 * Row-level permissions (doc 14/16). Both tables are readable **iff the row's
 * `workspaceId` matches the reader's `workspaceId` JWT claim** (nested under `claims`).
 * Clients never write: the backend projector writes with a privileged secret (`asBackend`)
 * that bypasses policies. Anonymous local-first auth is rejected at the server.
 *
 * Single-workspace v1: each principal carries one `workspaceId` claim. Multi-workspace
 * membership (claim as a list + an IN match) is a later extension.
 */
export const permissions = s.definePermissions(app, (ctx: any) => {
  // Access is `ctx.policy.<table>` / `ctx.session.<claim>` at runtime (the alpha's
  // factory param type is out of sync, so `ctx` is typed loosely here). JWT claims are
  // nested under `claims`, so the reader's workspace is `session.claims.workspaceId`
  // (bracket form because the proxy doesn't chain nested property access).
  const workspace = ctx.session["claims.workspaceId"];
  ctx.policy.messages.allowRead.where({ workspaceId: workspace });
  ctx.policy.messages.allowInsert.never();
  ctx.policy.sessions.allowRead.where({ workspaceId: workspace });
  ctx.policy.sessions.allowInsert.never();
  ctx.policy.activity.allowRead.where({ workspaceId: workspace });
  ctx.policy.activity.allowInsert.never();
});

/** Extract renderable text from a pi message's `content` (string or content blocks). */
/** A tool call as it appears in an assistant message's content blocks. */
interface ToolCallBlock {
  type: "toolCall";
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * One-line description of a tool call, e.g. `spawn_subagent: Docs audit`.
 *
 * Assistant messages that *only* call tools carry no text, so without this they project
 * as empty rows and render as empty chat bubbles — which is exactly what a run of
 * subagents looked like before.
 */
export function describeToolCall(call: { name: string; arguments?: Record<string, unknown> }): string {
  const args = call.arguments ?? {};
  // Most informative field first; every built-in tool has one of these.
  const hint =
    (typeof args.title === "string" && args.title) ||
    (typeof args.path === "string" && args.path) ||
    (typeof args.command === "string" && args.command) ||
    (typeof args.pattern === "string" && args.pattern) ||
    (typeof args.task === "string" && args.task) ||
    "";
  const trimmed = hint.replace(/\s+/g, " ").trim();
  const short = trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
  return short ? `${call.name}: ${short}` : call.name;
}

/** Describe every tool call in a message's content, one per line. "" when there are none. */
export function toolCallsOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is ToolCallBlock => !!c && (c as { type?: string }).type === "toolCall")
    .map((c) => describeToolCall(c))
    .join("\n");
}

export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } => !!c && (c as { type?: string }).type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}