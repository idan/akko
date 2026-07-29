/**
 * SessionRegistry — lazy map from session id to live `SessionRuntime` (doc 03).
 *
 * This is the heart of the durable/liveness split. Live runtimes are a *cache*:
 * created on demand by rehydrating durable state, disposed when idle. Both top-level
 * conversations and subagents live here uniformly, which is what lets the web UI
 * render subagents with the same code as chats (doc 08).
 */

import type { PrincipalId, SessionId, SessionRef, WorkspaceId } from "./domain.ts";
import type { SessionRuntime } from "./session-runtime.ts";

/**
 * Decides which backend node owns the live runtime for a session (doc 03/12).
 *
 * With distributed execution this resolves `session → workspace → node`, backed by the
 * Hub's `NodeDirectory` (see `node.ts`). The interface is unchanged from the
 * single-node case: constant `{ local: true }` when there is only the co-located host,
 * a real remote node once daemons are enrolled. The `SessionRegistry` and the WS
 * gateway always consult it, so adding cross-node routing is a swap here, not a
 * rearchitecture (doc 02/03/12).
 */
export interface HostResolver {
  resolve(sessionId: SessionId): Promise<{ node: string; local: boolean }>;
  /** This node's id, for stamping `SessionRef.hostNode`. */
  self(): string;
}

/** Options for spawning a subagent as a first-class session (doc 03/08). */
export interface SpawnSubagentOptions {
  parentSessionId: SessionId;
  workspaceId: WorkspaceId;
  /** The principal on whose behalf the subagent acts (usually a service principal). */
  actorId: PrincipalId;
  /** Agent-type name resolved from an agent `.md` definition (frontmatter, doc 03). */
  agentType?: string;
  /** Initial task/prompt for the subagent. */
  prompt: string;
  /** Optional model override (string form; resolved by the router — doc 05). */
  model?: string;
  title?: string;
}

export interface SessionRegistry {
  /**
   * Get the live runtime for a session, creating (rehydrating) it if needed. This is
   * the lazy-liveness entry point: cold sessions cost nothing until accessed.
   */
  get(sessionId: SessionId): Promise<SessionRuntime>;

  /** Whether a live runtime currently exists (without creating one). */
  isLive(sessionId: SessionId): boolean;

  /**
   * Create a brand-new top-level conversation session (durable + ref), returning its
   * live runtime.
   */
  createConversation(input: {
    workspaceId: WorkspaceId;
    ownerId: PrincipalId;
    title?: string;
  }): Promise<SessionRuntime>;

  /**
   * Spawn a subagent as a registered session with `kind: "subagent"` and a
   * `parentSessionId`. Returns its runtime so the caller can await results or stream
   * its events. ACL inherits from the parent (doc 03).
   */
  spawnSubagent(options: SpawnSubagentOptions): Promise<SessionRuntime>;

  /** List session refs a principal may see in a workspace (ACL-filtered, from the DB). */
  list(workspaceId: WorkspaceId, principalId: PrincipalId): Promise<SessionRef[]>;

  /** Dispose the live runtime (liveness only); durable state remains. Idempotent. */
  evict(sessionId: SessionId): Promise<void>;

  /** Dispose all live runtimes (e.g. on graceful shutdown). */
  disposeAll(): Promise<void>;
}
