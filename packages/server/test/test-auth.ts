/**
 * Test doubles for the gateway auth seam (doc 16).
 *
 * `testAuth` derives the principal from an `x-test-principal` header instead of a real
 * Better Auth session cookie, so the gateway's HTTP + WS paths can be exercised without
 * standing up passkeys. `ownerMemberships` grants everyone `owner`, isolating the
 * gateway/transport behavior from membership policy (which has its own unit tests).
 */
import type { PrincipalId } from "@akko/core";
import type { MembershipStore } from "@akko/runtime";
import type { GatewayAuth } from "../src/gateway.ts";

export function testAuth(): GatewayAuth {
  return {
    handler: () => new Response("{}", { headers: { "content-type": "application/json" } }),
    getPrincipal: async (headers) => {
      const p = headers.get("x-test-principal");
      return p ? { principalId: p as PrincipalId, displayName: p, email: `${p}@test` } : null;
    },
  };
}

export const ownerMemberships: MembershipStore = {
  grant() {},
  roleFor: () => "owner",
  listForPrincipal: () => [],
  listForWorkspace: () => [],
};
