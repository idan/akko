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
  ctx.policy.activity.allowRead.where({ workspaceId: workspace });
  ctx.policy.activity.allowInsert.never();
});

/** Extract renderable text from a pi message's `content` (string or content blocks). */
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