import { describe, expect, test } from "bun:test";
import {
  RoleBasedPolicy,
  type Action,
  type AuthorizationContext,
  type AuthorizationPolicy,
  type Decision,
  type Principal,
  type Resource,
  type Role,
  type SessionRef,
  type SessionId,
  type PrincipalId,
  type WorkspaceId,
} from "@akko/core";

const principal: Principal = { id: "prn_x" as PrincipalId, kind: "user", displayName: "X" };
const ref: SessionRef = {
  id: "ses_1" as SessionId,
  workspaceId: "wsp_1" as WorkspaceId,
  ownerId: principal.id,
  kind: "conversation",
  createdAt: 0,
  updatedAt: 0,
};
const resource: Resource = { type: "session", session: ref };
const policy: AuthorizationPolicy = new RoleBasedPolicy();

const decide = (role: Role | undefined, action: Action) =>
  (policy.authorize({ principal, role } as AuthorizationContext, action, resource) as Decision).allow;

describe("RoleBasedPolicy", () => {
  test("non-members are denied everything", () => {
    expect(decide(undefined, { kind: "command", verb: "prompt" })).toBe(false);
    expect(decide(undefined, { kind: "session.read" })).toBe(false);
  });

  test("viewer may read but not mutate or create", () => {
    expect(decide("viewer", { kind: "session.read" })).toBe(true);
    expect(decide("viewer", { kind: "command", verb: "prompt" })).toBe(false);
    expect(decide("viewer", { kind: "session.create" })).toBe(false);
  });

  test("editor may read, mutate, and create — but not manage the workspace", () => {
    expect(decide("editor", { kind: "session.read" })).toBe(true);
    expect(decide("editor", { kind: "command", verb: "prompt" })).toBe(true);
    expect(decide("editor", { kind: "session.create" })).toBe(true);
    expect(decide("editor", { kind: "workspace.manageMembers" })).toBe(false);
    expect(decide("editor", { kind: "workspace.configure" })).toBe(false);
  });

  test("owner may do everything", () => {
    expect(decide("owner", { kind: "command", verb: "abort" })).toBe(true);
    expect(decide("owner", { kind: "session.create" })).toBe(true);
    expect(decide("owner", { kind: "workspace.manageMembers" })).toBe(true);
    expect(decide("owner", { kind: "workspace.configure" })).toBe(true);
  });
});
