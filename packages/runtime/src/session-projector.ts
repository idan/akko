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
  /** The external projection id for a session, if one exists. */
  projectionId(sessionId: SessionId): string | undefined;
}