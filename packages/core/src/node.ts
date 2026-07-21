/**
 * Nodes and the Hub-side directory (doc 12).
 *
 * A Node is an execution point: the co-located "local" SessionHost on the Hub
 * machine, or a remote daemon installed on a machine that has a codebase checked out.
 * The Hub authenticates nodes, tracks which workspaces each exposes, and resolves
 * `session → workspace → node` for command routing and placement.
 */

import type { NodeId, SessionId, WorkspaceId } from "./domain.ts";

export type NodeStatus = "online" | "offline" | "draining";

/** What a node can do — used for placement and isolation decisions (doc 09/12). */
export interface NodeCapabilities {
  /** Isolation modes this node supports for its workspaces (doc 09). */
  isolation: Array<"host" | "container">;
  /** Whether the node currently holds provider inference keys locally (doc 12 §inference). */
  holdsInferenceKeys: boolean;
  /** Optional coarse load signal for future placement heuristics. */
  maxConcurrentSessions?: number;
}

/** A registered execution point as the Hub sees it. */
export interface Node {
  id: NodeId;
  name: string;
  status: NodeStatus;
  /** Workspaces this node exposes (its filesystem holds their code). */
  workspaces: WorkspaceId[];
  capabilities: NodeCapabilities;
  lastHeartbeat: number;
}

/** Payload a node sends when it connects and enrolls. */
export interface NodeRegistration {
  name: string;
  workspaces: WorkspaceId[];
  capabilities: NodeCapabilities;
}

/**
 * Node authentication material. A daemon is a privileged execution point, so the Hub
 * must authenticate it (doc 12 §trust boundary). Kept minimal here; a real impl may
 * use mutual TLS or signed enrollment tokens.
 */
export interface NodeAuth {
  /** Enrollment / bearer token proving the node may join this Hub. */
  token: string;
}

/**
 * Hub-side registry of nodes plus placement + resolution. The `HostResolver`
 * (see `session-registry.ts`) is the session-facing view; a `NodeDirectory`
 * implements the underlying node/placement state.
 */
export interface NodeDirectory {
  /** Authenticate + register a connecting node. Rejects on bad auth. */
  register(registration: NodeRegistration, auth: NodeAuth): Promise<Node>;

  /** Record a liveness heartbeat (and optional load). */
  heartbeat(nodeId: NodeId, load?: { activeSessions: number }): Promise<void>;

  /** Mark a node draining/offline (graceful shutdown or lost heartbeat). */
  setStatus(nodeId: NodeId, status: NodeStatus): Promise<void>;

  get(nodeId: NodeId): Node | undefined;
  list(): Node[];

  /** Placement: which node hosts a workspace's code (doc 12 §placement). */
  nodeForWorkspace(workspaceId: WorkspaceId): NodeId | undefined;
  placeWorkspace(workspaceId: WorkspaceId, nodeId: NodeId): Promise<void>;

  /** Resolution used by `HostResolver`: session → workspace → node. */
  nodeForSession(sessionId: SessionId): Promise<NodeId | undefined>;
}

/**
 * How a node obtains inference credentials (doc 12 §inference). Modeled as config so
 * switching from node-held keys to hub-brokering is not a code change.
 */
export type InferenceRouting =
  /** Start here: the node holds its workspace's provider keys locally. */
  | { mode: "node-keys" }
  /** Target: node calls a Hub inference proxy; raw keys never leave the Hub. */
  | { mode: "hub-brokered"; endpoint: string };

export const DEFAULT_INFERENCE_ROUTING: InferenceRouting = { mode: "node-keys" };
