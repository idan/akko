/**
 * MembershipStore — the durable association of principals to workspaces with a role
 * (doc 02/16). This is the first real persistence of "who belongs to what," and the
 * source the registry consults to resolve an actor's `Role` for `authorize()`.
 *
 * Two implementations: `InMemoryMembershipStore` (default, tests) and
 * `SqliteMembershipStore` (durable, via `SqliteAdapter`). The store is intentionally
 * tiny — membership management (invites, role changes) is a later concern; v1 only
 * needs "grant owner on signup" + "resolve role for authz."
 */
import type { Membership, PrincipalId, Role, SqliteAdapter, WorkspaceId } from "@akko/core";

export interface MembershipStore {
  /** Add or update a membership (idempotent on the (workspace, principal) pair). */
  grant(membership: Membership): void;
  /** The principal's role in a workspace, or `undefined` if not a member. */
  roleFor(workspaceId: WorkspaceId, principalId: PrincipalId): Role | undefined;
  /** All memberships for a principal (drives workspace listing). */
  listForPrincipal(principalId: PrincipalId): Membership[];
  /** All memberships in a workspace (drives member listing). */
  listForWorkspace(workspaceId: WorkspaceId): Membership[];
}

const key = (w: WorkspaceId, p: PrincipalId): string => `${w}\u0000${p}`;

export class InMemoryMembershipStore implements MembershipStore {
  #byPair = new Map<string, Membership>();

  grant(m: Membership): void {
    this.#byPair.set(key(m.workspaceId, m.principalId), { ...m });
  }
  roleFor(workspaceId: WorkspaceId, principalId: PrincipalId): Role | undefined {
    return this.#byPair.get(key(workspaceId, principalId))?.role;
  }
  listForPrincipal(principalId: PrincipalId): Membership[] {
    return [...this.#byPair.values()].filter((m) => m.principalId === principalId);
  }
  listForWorkspace(workspaceId: WorkspaceId): Membership[] {
    return [...this.#byPair.values()].filter((m) => m.workspaceId === workspaceId);
  }
}

interface MembershipRow {
  workspace_id: string;
  principal_id: string;
  role: string;
}

export class SqliteMembershipStore implements MembershipStore {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS memberships (
        workspace_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        role         TEXT NOT NULL,
        PRIMARY KEY (workspace_id, principal_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memberships_principal ON memberships(principal_id);
    `);
  }

  grant(m: Membership): void {
    this.#db
      .prepare(
        `INSERT INTO memberships (workspace_id, principal_id, role) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id, principal_id) DO UPDATE SET role = excluded.role`,
      )
      .run(m.workspaceId, m.principalId, m.role);
  }

  roleFor(workspaceId: WorkspaceId, principalId: PrincipalId): Role | undefined {
    const row = this.#db
      .prepare("SELECT role FROM memberships WHERE workspace_id = ? AND principal_id = ?")
      .get<{ role: string }>(workspaceId, principalId);
    return (row?.role as Role | undefined) ?? undefined;
  }

  listForPrincipal(principalId: PrincipalId): Membership[] {
    return this.#db
      .prepare("SELECT * FROM memberships WHERE principal_id = ?")
      .all<MembershipRow>(principalId)
      .map(this.#toMembership);
  }

  listForWorkspace(workspaceId: WorkspaceId): Membership[] {
    return this.#db
      .prepare("SELECT * FROM memberships WHERE workspace_id = ?")
      .all<MembershipRow>(workspaceId)
      .map(this.#toMembership);
  }

  #toMembership(row: MembershipRow): Membership {
    return {
      workspaceId: row.workspace_id as WorkspaceId,
      principalId: row.principal_id as PrincipalId,
      role: row.role as Role,
    };
  }
}
