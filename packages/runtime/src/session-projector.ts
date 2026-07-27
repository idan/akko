/**
 * SessionProjector — a `Projector` (doc 04) that also owns per-session projection
 * lifecycle. Implemented by `@akko/server`'s `JazzProjector`; consumed by the registry
 * so it can create a projection when a session is created and expose its id (e.g. a
 * Jazz CoValue id) to clients.
 */
import type { Projector, SessionId, SessionRef } from "@akko/core";

export interface SessionProjector extends Projector {
  /** Create (or return) the projection for a session; returns its external id. */
  ensureSession(ref: SessionRef): string;
  /**
   * Project only a session's **metadata** (no history backfill, no live subscription).
   * Used to make the session list complete at boot without replaying every session's
   * conversation. Optional so other projectors need not implement it.
   */
  projectSessionMeta?(ref: SessionRef): void;
  /** The external projection id for a session, if one exists. */
  projectionId(sessionId: SessionId): string | undefined;
}