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
    role: s.string(),
    text: s.string(),
    createdAt: s.timestamp(),
    /** Attribution: principal id for user messages; "" for agent output (doc 04). */
    authorId: s.string(),
  }),
};

export const app = s.defineApp(appSchema);

/**
 * Row-level permissions (doc 14). Dev-permissive: anyone may read/insert the projected
 * messages so a local-first browser client can render without full auth. Real
 * workspace read-ACL (Workspace -> policy) comes later. The backend writes with a
 * privileged secret that bypasses policies regardless.
 */
export const permissions = s.definePermissions(app, (ctx: any) => {
  // Access is `ctx.policy.<table>` at runtime (the alpha's factory param type is
  // out of sync, so `ctx` is typed loosely here).
  ctx.policy.messages.allowRead.always();
  ctx.policy.messages.allowInsert.always();
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