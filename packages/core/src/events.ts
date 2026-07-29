/**
 * Domain events and the sinks that consume them.
 *
 * The single-writer `SessionRuntime` (see `session-runtime.ts`) is the only producer
 * of committed state for a session. It emits a stream that two independent sinks
 * consume (doc 04):
 *   - the `ConversationStore` (durable, canonical)
 *   - the `Projector` (realtime read-model for clients)
 *
 * It also re-broadcasts pi's live streaming events (text deltas, tool activity,
 * lifecycle) to connected clients via the `EventBus`, without those transient events
 * being canonical.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { CommittedEntry } from "./conversation-store.ts";
import type { PrincipalId, SessionId } from "./domain.ts";

/**
 * Akko-level events. These wrap or augment pi events with session identity and
 * attribution so a multiplexed transport (one WS carrying many sessions) can route
 * them.
 */
export type DomainEvent =
  /** A raw pi streaming/lifecycle event, tagged with its session. Transient. */
  | { type: "pi"; sessionId: SessionId; event: AgentSessionEvent }
  /** A committed entry (post-write), the durable read-model update. */
  | { type: "entry"; sessionId: SessionId; entry: CommittedEntry }
  /** Mailbox/queue changed — who is queued to drive the session (doc 03/08). */
  | { type: "queue"; sessionId: SessionId; pending: Array<{ actorId: PrincipalId; verb: string }> }
  /** Session metadata changed (title, model, host, lifecycle). */
  | { type: "session"; sessionId: SessionId; patch: Record<string, unknown> }
  /**
   * Long-running work reporting progress against a session (doc 03). A blocking tool can
   * occupy a turn for minutes while emitting no tokens — a batch of subagents being the
   * motivating case — so it says how far along it is rather than leaving the UI on a
   * static label. Transient: it drives the ephemeral activity row, never durable state.
   */
  | { type: "progress"; sessionId: SessionId; label: string; done: number; total: number };

/**
 * A consumer of the committed-entry stream for one session. `ConversationStore` and
 * `Projector` are both modeled as sinks; the runtime fans out to all of them. Sinks
 * are independent — none goes "through" another (doc 04).
 */
export interface EntrySink {
  onEntry(sessionId: SessionId, entry: CommittedEntry): Promise<void>;
}

/**
 * Pub/sub transport for `DomainEvent`s, keyed by session. In-process emitter today;
 * Redis/NATS later (doc 02). This is what the Jazz projector subscribes to in
 * order to fan events out to browser clients (doc 08).
 */
export interface EventBus {
  publish(event: DomainEvent): void;
  /** Subscribe to all events for a session. Returns an unsubscribe function. */
  subscribe(sessionId: SessionId, listener: (event: DomainEvent) => void): () => void;
}
