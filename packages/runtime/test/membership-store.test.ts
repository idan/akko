import { describe, expect, test } from "bun:test";
import type { PrincipalId, WorkspaceId } from "@akko/core";
import { BunSqliteAdapter, InMemoryMembershipStore, SqliteMembershipStore } from "../src/index.ts";
import type { MembershipStore } from "../src/index.ts";

const w1 = "wsp_1" as WorkspaceId;
const w2 = "wsp_2" as WorkspaceId;
const alice = "prn_alice" as PrincipalId;
const bob = "prn_bob" as PrincipalId;

function suite(name: string, make: () => MembershipStore) {
  describe(name, () => {
    test("grant then resolve role; non-members are undefined", () => {
      const store = make();
      store.grant({ workspaceId: w1, principalId: alice, role: "owner" });
      expect(store.roleFor(w1, alice)).toBe("owner");
      expect(store.roleFor(w1, bob)).toBeUndefined();
      expect(store.roleFor(w2, alice)).toBeUndefined();
    });

    test("grant is idempotent and updates the role in place", () => {
      const store = make();
      store.grant({ workspaceId: w1, principalId: alice, role: "viewer" });
      store.grant({ workspaceId: w1, principalId: alice, role: "editor" });
      expect(store.roleFor(w1, alice)).toBe("editor");
      expect(store.listForWorkspace(w1)).toHaveLength(1);
    });

    test("lists by principal and by workspace", () => {
      const store = make();
      store.grant({ workspaceId: w1, principalId: alice, role: "owner" });
      store.grant({ workspaceId: w2, principalId: alice, role: "viewer" });
      store.grant({ workspaceId: w1, principalId: bob, role: "editor" });

      expect(store.listForPrincipal(alice).map((m) => m.workspaceId).sort()).toEqual([w1, w2].sort());
      expect(store.listForWorkspace(w1).map((m) => m.principalId).sort()).toEqual([alice, bob].sort());
    });
  });
}

suite("InMemoryMembershipStore", () => new InMemoryMembershipStore());
suite("SqliteMembershipStore", () => new SqliteMembershipStore(new BunSqliteAdapter(":memory:")));
