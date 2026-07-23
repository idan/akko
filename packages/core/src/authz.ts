/**
 * Authorization — the single choke point.
 *
 * Every mutating command passes through `authorize()` before it is applied. Today it
 * returns ALLOW for the single user; the point is that the *shape* exists so we never
 * have to retrofit an authz thread through N handlers later
 * (see `docs/architecture/02-tenancy-and-identity.md`).
 *
 * This is also where **concurrency policy** is expressed (free-for-all vs. turn-lock
 * vs. role-gated), because the natural place to decide "may this actor drive this
 * session right now?" is the same gate the mailbox consults (doc 03).
 */

import type { Command, Principal, Role, SessionRef, WorkspaceId } from "./domain.ts";

/**
 * The thing being acted upon. Kept as a small union so policies can match on it
 * structurally.
 */
export type Resource =
  | { type: "workspace"; workspaceId: WorkspaceId }
  | { type: "session"; session: SessionRef }
  | { type: "membership"; workspaceId: WorkspaceId };

/** Actions map 1:1 with `CommandVerb` plus workspace/membership management. */
export type Action =
  | { kind: "command"; verb: Command["verb"] }
  | { kind: "session.read" }
  | { kind: "session.create" }
  | { kind: "workspace.manageMembers" }
  | { kind: "workspace.configure" };

export interface Decision {
  allow: boolean;
  /** Human-readable reason, surfaced to the client on denial. */
  reason?: string;
}

export const ALLOW: Decision = { allow: true };
export const deny = (reason: string): Decision => ({ allow: false, reason });

/**
 * Context handed to a policy so it can make role- and state-aware decisions without
 * re-querying stores.
 */
export interface AuthorizationContext {
  principal: Principal;
  /** The principal's role in the relevant workspace, if any. */
  role?: Role;
  /**
   * Current concurrency holder, if the session enforces turn-taking. `undefined`
   * means no one holds the turn. Provided so a policy can implement turn-lock.
   */
  currentDriver?: Principal["id"];
}

/**
 * A pluggable policy. The default single-user policy returns ALLOW. A multiuser
 * policy inspects role + action + resource (+ concurrency context) and decides.
 */
export interface AuthorizationPolicy {
  authorize(
    ctx: AuthorizationContext,
    action: Action,
    resource: Resource,
  ): Decision | Promise<Decision>;
}

/** Trivial day-one policy: everything is allowed. Swap later without touching callers. */
export class AllowAllPolicy implements AuthorizationPolicy {
  authorize(): Decision {
    return ALLOW;
  }
}

/**
 * Role-based policy (doc 16). Resolves the decision from the actor's role in the
 * relevant workspace (supplied on the `AuthorizationContext` by the registry, which
 * reads it from the `MembershipStore`). A missing role means "not a member" → deny.
 *
 * - **owner**  — everything (incl. workspace configure / manage members)
 * - **editor** — all session commands + read + create; not workspace management
 * - **viewer** — read only; no mutating commands, no create
 *
 * Concurrency policy (turn-lock via `currentDriver`) can layer on top of this later at
 * the same gate; for now role is the whole decision.
 */
export class RoleBasedPolicy implements AuthorizationPolicy {
  authorize(ctx: AuthorizationContext, action: Action): Decision {
    const role = ctx.role;
    if (!role) return deny("not a member of this workspace");

    switch (action.kind) {
      case "session.read":
        // Any member may read.
        return ALLOW;
      case "command":
        // Mutating a session requires write access.
        return role === "viewer" ? deny("viewers cannot modify a session") : ALLOW;
      case "session.create":
        return role === "viewer" ? deny("viewers cannot create sessions") : ALLOW;
      case "workspace.manageMembers":
      case "workspace.configure":
        return role === "owner" ? ALLOW : deny("only the workspace owner may do this");
      default:
        return deny("unknown action");
    }
  }
}
