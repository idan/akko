/**
 * @akko/schema — Jazz CoValue schemas (doc 14).
 *
 * The shared, dependency-light projection schema used by the backend worker (to write)
 * and the frontend (to read). These CoValues are a *projection* of the canonical SQLite
 * conversation — never the source of truth (doc 04). Live token streaming stays on the
 * WS; only finalized messages are projected here.
 */
import { co, z } from "jazz-tools";

/** One finalized message in the projected conversation. */
export const Message = co.map({
  role: z.literal(["user", "assistant"]),
  text: z.string(),
  createdAt: z.number(),
  /** Attribution: the principal id that authored a user message (doc 04). */
  authorId: z.optional(z.string()),
});
export type Message = co.loaded<typeof Message>;

/** The projected conversation for one session: metadata + an ordered list of messages. */
export const Conversation = co.map({
  sessionId: z.string(),
  title: z.string(),
  messages: co.list(Message),
});
export type Conversation = co.loaded<typeof Conversation>;

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