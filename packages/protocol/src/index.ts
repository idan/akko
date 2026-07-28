/**
 * @akko/protocol — the HTTP gateway wire protocol (doc 08).
 *
 * Shared between the server (`@akko/server`) and the browser (`@akko/web`). It depends
 * only on `@akko/core` types (which are erased at build), so importing it into the
 * frontend pulls no `bun`/pi runtime.
 *
 * CQRS: clients POST attributed **commands** over HTTP and observe every effect through
 * the **Jazz read model** (doc 14/15) — there is no socket and no client-side event
 * folding. Clients never mutate state directly: a command becomes an attributed
 * `Command` posted to the owning session's mailbox (doc 03/04), and identity comes from
 * the Better Auth session cookie server-side, never from the request body.
 */
import type { CommandVerb, MailboxResult, ModelCatalogEntry, SessionRef } from "@akko/core";

export type { CommandVerb, DomainEvent, MailboxResult, ModelCatalogEntry, SessionRef } from "@akko/core";

/** HTTP: POST /api/sessions/:id/commands. The actor is derived server-side. */
export interface CommandRequest {
  verb: CommandVerb;
  args?: Record<string, unknown>;
  streamingBehavior?: "steer" | "followUp";
}
export interface CommandResponse {
  result: MailboxResult;
}

/** A session as the API returns it. */
export type SessionSummary = SessionRef;

/** HTTP: create-conversation request/response bodies. */
export interface CreateSessionRequest {
  workspaceId: string;
  title?: string;
  /** Optional human-ish model string, resolved server-side (doc 05). */
  model?: string;
}
export interface CreateSessionResponse {
  ref: SessionSummary;
}
export interface ListSessionsResponse {
  sessions: SessionSummary[];
}

/** HTTP: available models for a workspace (doc 05) — powers the model picker. */
export interface ListModelsResponse {
  models: ModelCatalogEntry[];
}

/**
 * A finalized message for seeding the UI on (re)select (doc 08). `content` is pi's
 * message content verbatim (string or content blocks). Primarily feeds the read-model
 * backfill and debugging now that the browser reads from Jazz.
 */
export interface HistoryMessage {
  id: string;
  role: string;
  content: unknown;
  /** Attribution: principal id for user messages; undefined for agent output (doc 04). */
  authorId?: string;
}
export interface SessionHistoryResponse {
  messages: HistoryMessage[];
}