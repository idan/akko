/**
 * Projector — the realtime read-model sink (doc 04/08).
 *
 * The Projector pushes committed entries into a client-facing store (e.g. Jazz) that
 * browsers render and collaborate on. It is a **sibling** of the `ConversationStore`,
 * never downstream of the UI and never a source of truth:
 *
 *   - projected conversation  = derived from canonical; fully recreatable by replay
 *   - ephemeral collab state  = presence/typing/drafts; client-owned, disposable
 *
 * Keeping this separate from `ConversationStore` means the projection can be swapped
 * or removed without touching durable persistence.
 */

import type { EntrySink } from "./events.ts";
import type { SessionId } from "./domain.ts";

/**
 * Writes the derived, client-facing view. Implemented once (e.g. a Jazz-backed
 * projector); the runtime treats it as just another `EntrySink`.
 */
export interface Projector extends EntrySink {
  /**
   * Rebuild the entire projection for a session from canonical storage. Used on first
   * projection, after projection loss/corruption, or when a session is rehydrated on a
   * new node. Guarantees the "recreatable from canonical" property (doc 04).
   */
  rebuild(sessionId: SessionId): Promise<void>;

  /** Drop the projection for a session (e.g. when it is deleted or evicted). */
  drop(sessionId: SessionId): Promise<void>;
}

/** A projector that does nothing — the single-user, no-Jazz default. */
export class NullProjector implements Projector {
  async onEntry(): Promise<void> {}
  async rebuild(): Promise<void> {}
  async drop(): Promise<void> {}
}
