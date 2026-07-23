/**
 * @akko/protocol — the WS + HTTP gateway wire protocol (doc 08).
 *
 * Shared between the server (`@akko/server`) and the browser (`@akko/web`). It depends
 * only on `@akko/core` types (which are erased at build), so importing it into the
 * frontend pulls no `bun`/pi runtime.
 *
 * CQRS over one multiplexed WebSocket: clients send attributed **commands** and
 * **subscribe** to sessions; the server streams **events** back. Clients never mutate
 * state directly — a `command` becomes an attributed `Command` posted to the owning
 * session's mailbox (doc 03/04). Identity (`principalId`) is established at connection
 * time, not per message.
 */
import type { CommandVerb, DomainEvent, MailboxResult, ModelCatalogEntry, SessionRef } from "@akko/core";

export type { CommandVerb, DomainEvent, MailboxResult, ModelCatalogEntry, SessionRef } from "@akko/core";

/** Client -> server. */
export type ClientMessage =
  | { t: "subscribe"; sessionId: string }
  | { t: "unsubscribe"; sessionId: string }
  | {
      t: "command";
      cid?: string;
      sessionId: string;
      verb: CommandVerb;
      args?: unknown;
      streamingBehavior?: "steer" | "followUp";
    };

/** Server -> client. */
export type ServerMessage =
  | { t: "welcome"; principalId: string }
  | { t: "subscribed"; sessionId: string }
  | { t: "event"; event: DomainEvent }
  | { t: "ack"; cid?: string; sessionId: string; result: MailboxResult }
  | { t: "error"; cid?: string; message: string };

/** A session plus its optional Jazz projection id (doc 14). */
export type SessionSummary = SessionRef & { jazzId?: string };

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
 * message content verbatim (string or content blocks) — the same shape carried over the
 * WS `event` stream — so the frontend reduces it with the same text extraction.
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