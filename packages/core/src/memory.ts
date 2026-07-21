/**
 * Memory seam (doc 07).
 *
 * We are deferring a real memory implementation, but we bake in the seam now so the
 * `before_agent_start` injection point and the storage/attribution model don't have
 * to change later. The scope is keyed to Akko's actual domain (workspace + optional
 * principal/session overlays), which is a superset of existing providers'
 * project/local/user scopes.
 */

import type { PrincipalId, SessionId, WorkspaceId } from "./domain.ts";

/**
 * Where a memory lives and who can see it. Explicitly answers the multiuser questions
 * that off-the-shelf providers answer for a different world (doc 07).
 */
export interface MemoryScope {
  workspaceId: WorkspaceId;
  /** Optional per-principal overlay on top of workspace memory. */
  principalId?: PrincipalId;
  /** Optional session-local memory. */
  sessionId?: SessionId;
  /** Whether subagents of the session may read this memory. */
  subagentVisible?: boolean;
}

export interface MemoryItem {
  text: string;
  /** Free-form tags/kind for later filtering (e.g. "preference", "fact", "correction"). */
  kind?: string;
  metadata?: Record<string, unknown>;
  ts?: number;
}

export interface MemoryHit extends MemoryItem {
  score: number;
}

/**
 * Recall + remember. Bound into a `before_agent_start` hook per session for injection;
 * writes go through the single-writer `SessionRuntime` to keep the authority model
 * intact (doc 04/07).
 */
export interface MemoryProvider {
  recall(scope: MemoryScope, query: string, limit?: number): Promise<MemoryHit[]>;
  remember(scope: MemoryScope, item: MemoryItem): Promise<void>;
}

/** Day-one no-op. Recall returns nothing; remember discards. Swap in a real provider later. */
export class NullMemoryProvider implements MemoryProvider {
  async recall(): Promise<MemoryHit[]> {
    return [];
  }
  async remember(): Promise<void> {}
}
