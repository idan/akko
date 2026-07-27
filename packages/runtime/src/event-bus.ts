/**
 * InMemoryEventBus — the day-one `EventBus` (doc 08). In-process pub/sub keyed by
 * session id. A distributed transport (Redis/NATS) swaps in behind the same interface
 * later (doc 02).
 */
import type { DomainEvent, EventBus, SessionId } from "@akko/core";

type Listener = (event: DomainEvent) => void;

export class InMemoryEventBus implements EventBus {
  #listeners = new Map<SessionId, Set<Listener>>();

  publish(event: DomainEvent): void {
    const set = this.#listeners.get(event.sessionId);
    if (!set) return;
    // Copy to tolerate unsubscribe during iteration, and isolate failures: one throwing
    // listener (e.g. a projector write error) must never break delivery to the others
    // (notably the WS gateway) or propagate back into the runtime.
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[eventbus] listener failed for ${event.sessionId} (${event.type}):`, error);
      }
    }
  }

  subscribe(sessionId: SessionId, listener: Listener): () => void {
    let set = this.#listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.#listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.#listeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(sessionId);
    };
  }
}
