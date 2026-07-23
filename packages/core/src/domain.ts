/**
 * Akko core domain model.
 *
 * These are the multiuser-shaped primitives that every other module keys off of.
 * They are deliberately small; the invariant that matters (see
 * `docs/architecture/02-tenancy-and-identity.md`) is that **identity is present on
 * every record from day one**, even while Akko is single-user.
 *
 * Nothing here depends on pi. This is Akko's own vocabulary; pi is bound to it by
 * the `WorkspaceRuntime` (see `workspace.ts`).
 */

/**
 * Branded string id helpers. Using nominal-ish ids prevents accidentally passing a
 * `SessionId` where a `WorkspaceId` is expected, which is a real source of bugs once
 * many id types coexist.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type PrincipalId = Brand<string, "PrincipalId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type SessionId = Brand<string, "SessionId">;
/** pi's own 8-char entry id within a session tree. */
export type EntryId = Brand<string, "EntryId">;
export type CommandId = Brand<string, "CommandId">;
/** Identifies which backend node currently hosts a live session (doc 03). */
export type NodeId = Brand<string, "NodeId">;

/**
 * An actor in the system. A `user` is a human; a `service` is a non-human caller
 * (automation, a scheduled job, or a subagent acting on behalf of its parent).
 */
export interface Principal {
  id: PrincipalId;
  kind: "user" | "service";
  displayName: string;
}

/**
 * The tenancy boundary. A workspace owns everything that must be partitioned per
 * tenant: filesystem/cwd, session storage, credentials + entitled models, resource
 * configuration (skills/extensions), and memory.
 *
 * - single-user  = one workspace with one owner member
 * - multiplayer  = one workspace, many members sharing sessions
 * - multi-tenant = many workspaces
 */
export interface Workspace {
  id: WorkspaceId;
  name: string;
  /** Root under which pi cwd + session storage + per-workspace config live. */
  storageRoot: string;
  /** Execution isolation level. See `docs/architecture/09-security-and-isolation.md`. */
  isolation: "host" | "container";
  /**
   * Placement: the node whose filesystem holds this workspace's code (doc 12).
   * `undefined` = the local/hub node. Sessions for this workspace run on this node;
   * subagents are pinned to the same node.
   */
  nodeId?: NodeId;
}

export type Role = "owner" | "editor" | "viewer";

/** Association of a principal to a workspace with a role. */
export interface Membership {
  workspaceId: WorkspaceId;
  principalId: PrincipalId;
  role: Role;
}

export type SessionKind = "conversation" | "subagent";

/**
 * Akko's record of a session. This lives in **our** database, not in pi. It is the
 * index/ACL/metadata layer that makes fast listing and authorization possible
 * without scanning pi's session content (see `docs/architecture/04-storage-and-persistence.md`).
 *
 * The canonical *content* of the session lives in the `ConversationStore`
 * (`conversation-store.ts`); this is only the handle + metadata.
 */
export interface SessionRef {
  id: SessionId;
  workspaceId: WorkspaceId;
  ownerId: PrincipalId;
  kind: SessionKind;
  /** Present when `kind === "subagent"`: the session that spawned this one. */
  parentSessionId?: SessionId;
  /** Human-readable title (mirrors pi's session_info name when set). */
  title?: string;
  /** Resolved model id (`provider/id`) this session uses; set on create / setModel (doc 05). */
  model?: string;
  /** Which node currently owns the live runtime (doc 03). */
  hostNode?: NodeId;
  createdAt: number;
  updatedAt: number;
}

/**
 * The set of mutating operations a client can request against a session. Everything
 * a user does is one of these — never a direct method call on a live `AgentSession`.
 * This closed set is what the mailbox carries and what `authorize()` gates.
 */
export type CommandVerb =
  | "prompt"
  | "steer"
  | "followUp"
  | "abort"
  | "setModel"
  | "setThinkingLevel"
  | "compact"
  | "fork"
  | "clone"
  | "navigateTree"
  | "spawnSubagent"
  | "stopSubagent"
  | "setSkillEnabled"
  | "rename";

/**
 * An **attributed** command. Attribution (`actorId`) is the multiplayer substrate:
 * it is recorded so we always know who did what, and it is where per-entry
 * authorship comes from (doc 02/04). Commands form an append-only log used for
 * audit, sync, and (optionally) replay.
 */
export interface Command<V extends CommandVerb = CommandVerb> {
  id: CommandId;
  sessionId: SessionId;
  actorId: PrincipalId;
  verb: V;
  /** Verb-specific payload. Kept `unknown` here; refined per-verb at the edges. */
  args: unknown;
  ts: number;
  /**
   * How to deliver while the session is streaming. Mirrors pi's
   * `PromptOptions.streamingBehavior`. Ignored for verbs that always apply
   * immediately (e.g. `abort`).
   */
  streamingBehavior?: "steer" | "followUp";
}
