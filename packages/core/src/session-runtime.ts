/**
 * SessionRuntime and the per-session Mailbox (doc 03).
 *
 * A `SessionRuntime` owns exactly one live pi `AgentSession` and is the **single
 * writer** for that session. It is an actor: you never call the `AgentSession`
 * directly — you `post()` an attributed `Command` to its mailbox, and the runtime
 * drains the mailbox one item at a time, applying each via pi's API (`prompt` when
 * idle, `steer`/`followUp` when busy).
 *
 * The runtime is **liveness only**: it can be disposed and rebuilt from durable
 * storage at any time (doc 03/04).
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Command, PrincipalId, SessionId, SessionRef } from "./domain.ts";

/**
 * An attributed unit of work in a session's mailbox. Carries the originating command
 * (with its `actorId`) plus a resolver so the poster can await application.
 */
export interface MailboxItem {
  command: Command;
  /** Resolved once the command has been accepted/applied (or rejected). */
  settle: (result: MailboxResult) => void;
}

export interface MailboxResult {
  accepted: boolean;
  /** Reason when `accepted === false` (authz denial, invalid state, etc.). */
  reason?: string;
}

/**
 * A single-consumer, in-order queue for one session. This is where serialization,
 * authorization, and concurrency policy meet (doc 03). Only the owning
 * `SessionRuntime` consumes it.
 */
export interface Mailbox {
  /**
   * Enqueue an attributed command. Resolves when the item settles (accepted, queued,
   * or rejected). Rejection happens for authz denials or illegal state.
   */
  post(command: Command): Promise<MailboxResult>;

  /** Snapshot of pending items, for `queue_update`-style UI (doc 08). */
  pending(): Array<{ actorId: PrincipalId; verb: Command["verb"] }>;

  /** Length of the queue. */
  size(): number;
}

/**
 * The live runtime for one session. Created lazily by the `SessionRegistry`, wired to
 * the durable store + projector sinks + event bus, and disposed when idle.
 */
export interface SessionRuntime {
  readonly ref: SessionRef;

  /** The mailbox is the only sanctioned way to mutate the session. */
  readonly mailbox: Mailbox;

  /**
   * Direct handle to pi's session. Exposed for read-only introspection (messages,
   * state, stats) and internal use by the runtime. Callers MUST NOT drive it directly
   * for mutations — go through the mailbox so serialization/authz/attribution hold.
   */
  readonly session: AgentSession;

  /** True while pi is actively streaming or has pending queued work. */
  isBusy(): boolean;

  /**
   * Tear down liveness (unsubscribe, `session.dispose()`), leaving durable state
   * intact. Safe to call when idle; the registry re-creates on next access.
   */
  dispose(): Promise<void>;
}

/**
 * Concurrency policy for a session's mailbox. Kept separate from `authorize()` shape
 * but consulted alongside it (doc 02/03). Default: free-for-all.
 */
export type ConcurrencyPolicy =
  /** Anyone with sufficient role may prompt/steer; steers apply in order. */
  | { mode: "free-for-all" }
  /** Only the current driver may prompt/steer until they yield or go idle. */
  | { mode: "turn-lock" }
  /** Specific verbs restricted to specific roles (e.g. only owner may abort). */
  | { mode: "role-gated"; restrict: Partial<Record<Command["verb"], "owner" | "editor">> };

export const DEFAULT_CONCURRENCY: ConcurrencyPolicy = { mode: "free-for-all" };

/** Drives the mailbox loop for a session id (used by the registry when constructing runtimes). */
export type MailboxDrainer = (sessionId: SessionId, item: MailboxItem) => Promise<MailboxResult>;
