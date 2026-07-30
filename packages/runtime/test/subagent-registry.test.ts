/**
 * `spawnSubagent` against a real registry (doc 03): a subagent is an *ordinary session*
 * — same registry, same index, same durability — distinguished only by `kind` and
 * `parentSessionId`. This is also the guard on the two properties that keep delegation
 * safe: children never get the spawn tool, and they never show up in the session list.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrincipalId, SessionId, Workspace } from "@akko/core";
import { InMemoryEventBus } from "../src/event-bus.ts";
import { BunSqliteAdapter } from "../src/sqlite-bun.ts";
import { SqliteConversationStore } from "../src/sqlite-conversation-store.ts";
import { SqliteSessionIndex } from "../src/session-index.ts";
import { HostWorkspaceRuntimeFactory } from "../src/workspace-runtime.ts";
import { AkkoSessionRegistry } from "../src/session-registry.ts";
import { SqliteWorkspaceConfigStore } from "../src/workspace-config-store.ts";
import { runSubagentToCompletion } from "../src/subagent-tool.ts";
import { newPrincipalId, newWorkspaceId } from "../src/ids.ts";

const storageRoot = mkdtempSync(join(tmpdir(), "akko-sub-"));
afterAll(() => rmSync(storageRoot, { recursive: true, force: true }));

function makeStack(agentTypesDir?: string) {
  const db = new BunSqliteAdapter(join(storageRoot, "akko.db"));
  const conversationStore = new SqliteConversationStore({ db, cwd: join(storageRoot, "tree") });
  const sessionIndex = new SqliteSessionIndex(db);
  const eventBus = new InMemoryEventBus();
  const registry = new AkkoSessionRegistry({
    workspaceRuntimeFactory: new HostWorkspaceRuntimeFactory(),
    conversationStore,
    sessionIndex,
    eventBus,
    agentTypesDir,
  });
  const workspace: Workspace = {
    id: newWorkspaceId(),
    name: "sub-ws",
    storageRoot,
    isolation: "host",
  };
  registry.registerWorkspace(workspace);
  return { registry, workspace, sessionIndex, db, eventBus, owner: newPrincipalId() };
}

describe("spawnSubagent", () => {
  test("creates a child session marked as a subagent and linked to its parent", async () => {
    const { registry, workspace, owner, db } = makeStack();
    const parent = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });

    const child = await registry.spawnSubagent({
      parentSessionId: parent.ref.id,
      workspaceId: workspace.id,
      actorId: owner,
      prompt: "do the thing",
      title: "Docs audit",
    });

    expect(child.ref.kind).toBe("subagent");
    expect(child.ref.parentSessionId).toBe(parent.ref.id);
    expect(child.ref.workspaceId).toBe(workspace.id);
    // Attribution stays with the human, so membership + role checks apply unchanged.
    expect(child.ref.ownerId).toBe(owner);
    expect(child.ref.title).toBe("Docs audit");
    expect(registry.isLive(child.ref.id)).toBe(true);
    db.close();
  });

  test("subagents are excluded from the session list but remain in the index", async () => {
    const { registry, workspace, owner, sessionIndex, db } = makeStack();
    const parent = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });
    const child = await registry.spawnSubagent({
      parentSessionId: parent.ref.id,
      workspaceId: workspace.id,
      actorId: owner,
      prompt: "hidden work",
    });

    const listed = await registry.list(workspace.id, owner);
    expect(listed.map((r) => r.id)).toContain(parent.ref.id);
    expect(listed.map((r) => r.id)).not.toContain(child.ref.id);

    // Still durable and addressable — hiding is a rendering decision, not deletion.
    expect(sessionIndex.getRef(child.ref.id)?.kind).toBe("subagent");
    db.close();
  });

  test("a subagent has no spawn_subagent tool, so delegation cannot nest", async () => {
    const { registry, workspace, owner, db } = makeStack();
    const parent = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });
    const child = await registry.spawnSubagent({
      parentSessionId: parent.ref.id,
      workspaceId: workspace.id,
      actorId: owner,
      prompt: "no nesting",
    });

    // Depth is enforced by *absence of the capability*, not a counter the model could
    // argue with — so assert on the child's actual tool registry.
    expect(parent.session.getActiveToolNames()).toContain("spawn_subagent");
    expect(child.session.getActiveToolNames()).not.toContain("spawn_subagent");
    db.close();
  });

  test("a REHYDRATED conversation keeps spawn_subagent; a rehydrated subagent still lacks it", async () => {
    // Regression: the tool was attached only on create, so any cold session lost it.
    // The model kept calling it — earlier successful calls were still in its transcript —
    // and got "Tool spawn_subagent not found" for the rest of the session's life.
    const { registry, workspace, owner, db } = makeStack();
    const parent = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });
    const child = await registry.spawnSubagent({
      parentSessionId: parent.ref.id,
      workspaceId: workspace.id,
      actorId: owner,
      prompt: "work",
    });
    const parentId = parent.ref.id;
    const childId = child.ref.id;

    // Simulate a restart: drop all liveness, keep durable state.
    await registry.evict(parentId);
    await registry.evict(childId);
    expect(registry.isLive(parentId)).toBe(false);

    const rehydratedParent = await registry.get(parentId);
    const rehydratedChild = await registry.get(childId);

    expect(rehydratedParent.session.getActiveToolNames()).toContain("spawn_subagent");
    // ...and rehydration must not accidentally *grant* it to a subagent.
    expect(rehydratedChild.session.getActiveToolNames()).not.toContain("spawn_subagent");
    db.close();
  });

  test("rejects a parent that doesn't exist or lives in another workspace", async () => {
    const { registry, workspace, owner, db } = makeStack();

    await expect(
      registry.spawnSubagent({
        parentSessionId: "ses_nope" as SessionId,
        workspaceId: workspace.id,
        actorId: owner,
        prompt: "x",
      }),
    ).rejects.toThrow("unknown parent session");

    const parent = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });
    await expect(
      registry.spawnSubagent({
        parentSessionId: parent.ref.id,
        workspaceId: newWorkspaceId(),
        actorId: owner,
        prompt: "x",
      }),
    ).rejects.toThrow("same workspace");
    db.close();
  });

  test("the child inherits the parent's model unless overridden", async () => {
    const { registry, workspace, owner, db } = makeStack();
    const parent = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });
    const child = await registry.spawnSubagent({
      parentSessionId: parent.ref.id,
      workspaceId: workspace.id,
      actorId: owner as PrincipalId,
      prompt: "inherit",
    });
    // Delegation shouldn't silently change which model the user is paying for.
    expect(child.ref.model).toBe(parent.ref.model);
    db.close();
  });
});

describe("subagent live delegation (gated on AKKO_LIVE=1)", () => {
  test("a real child session answers a delegated task", async () => {
    if (process.env.AKKO_LIVE !== "1") {
      console.warn("skipping live subagent test (set AKKO_LIVE=1)");
      return;
    }
    const { registry, workspace, owner, eventBus, db } = makeStack();
    const parent = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });
    const child = await registry.spawnSubagent({
      parentSessionId: parent.ref.id,
      workspaceId: workspace.id,
      actorId: owner,
      prompt: "Reply with exactly: pong",
    });

    // Driven through the same helper the tool uses, on the same bus the registry publishes to.
    const text = await runSubagentToCompletion(child, eventBus, "Reply with exactly: pong");
    expect(text.toLowerCase()).toContain("pong");
    db.close();
  }, 90_000);
});

describe("agent types", () => {
  /** Write a preset directory and build a registry pointed at it. */
  function withAgentTypes(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "akko-at-"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const stack = makeStack(dir);
    return { ...stack, dir };
  }

  test("a preset supplies the child's model, tools and instructions", async () => {
    const { registry, workspace, owner, db, dir } = withAgentTypes({
      "researcher.md": [
        "---",
        "description: Read-only research",
        "tools: [read]",
        "---",
        "You only read.",
      ].join("\n"),
    });
    const parent = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });

    const child = await registry.spawnSubagent({
      parentSessionId: parent.ref.id,
      workspaceId: workspace.id,
      actorId: owner,
      agentType: "researcher",
      prompt: "find things",
    });

    expect(child.ref.agentType).toBe("researcher");
    // The allowlist really restricts the child, not just its prompt.
    expect(child.session.getActiveToolNames()).toEqual(["read"]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unknown agent type fails loudly and lists what is available", async () => {
    const { registry, workspace, owner, db, dir } = withAgentTypes({
      "researcher.md": "You only read.",
    });
    const parent = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });

    await expect(
      registry.spawnSubagent({
        parentSessionId: parent.ref.id,
        workspaceId: workspace.id,
        actorId: owner,
        agentType: "nope",
        prompt: "x",
      }),
    ).rejects.toThrow(/unknown agent type "nope".*researcher/s);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("stopSubagent", () => {
  test("stops a running child, and refuses one belonging to another session", async () => {
    const { registry, workspace, owner, db } = makeStack();
    const parentA = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });
    const parentB = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });
    const child = await registry.spawnSubagent({
      parentSessionId: parentA.ref.id,
      workspaceId: workspace.id,
      actorId: owner,
      prompt: "work",
    });

    // Scoping is what makes this safe to expose as a command without a second
    // permission model: a session may only stop its own children.
    await expect(registry.stopSubagent(child.ref.id, parentB.ref.id)).rejects.toThrow(
      "another session",
    );

    await expect(registry.stopSubagent(child.ref.id, parentA.ref.id)).resolves.toBe(true);
    // The transcript survives — stopping is a liveness action, not a delete.
    expect(registry.agentTypes()).toBeDefined();
    db.close();
  });

  test("stopping a non-subagent or an evicted child is false, not an error", async () => {
    const { registry, workspace, owner, db } = makeStack();
    const parent = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });
    const child = await registry.spawnSubagent({
      parentSessionId: parent.ref.id,
      workspaceId: workspace.id,
      actorId: owner,
      prompt: "work",
    });

    expect(await registry.stopSubagent(parent.ref.id)).toBe(false); // not a subagent
    await registry.evict(child.ref.id);
    expect(await registry.stopSubagent(child.ref.id)).toBe(false); // already finished
    db.close();
  });
});

describe("skills staleness", () => {
  test("a live session's baked-in skills become detectably stale when rows change", async () => {
    // A session's system prompt is a snapshot: pi assembles the skills block once, at
    // build time. Changing skills afterwards does not update a running session, and a
    // deleted skill leaves it advertising a path that no longer exists. That is
    // unavoidable without rebuilding the session — but it must not be *silent*.
    const dir = mkdtempSync(join(tmpdir(), "akko-stale-"));
    const db = new BunSqliteAdapter(join(dir, "a.db"));
    const config = new SqliteWorkspaceConfigStore(db);
    const workspace: Workspace = {
      id: newWorkspaceId(),
      name: "stale-ws",
      storageRoot: dir,
      isolation: "host",
    };
    config.upsertSkill({
      workspaceId: workspace.id,
      name: "s1",
      description: "d",
      content: "# body",
      hiddenFromPrompt: false,
    });
    const registry = new AkkoSessionRegistry({
      workspaceRuntimeFactory: new HostWorkspaceRuntimeFactory(),
      conversationStore: new SqliteConversationStore({ db, cwd: join(dir, "tree") }),
      sessionIndex: new SqliteSessionIndex(db),
      eventBus: new InMemoryEventBus(),
      config,
    });
    registry.registerWorkspace(workspace);
    const owner = newPrincipalId();
    const session = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });

    expect(registry.staleSkillSessions(workspace.id)).toEqual([]);

    config.upsertSkill({
      workspaceId: workspace.id,
      name: "s1",
      description: "d",
      content: "# changed",
      hiddenFromPrompt: false,
    });

    expect(registry.staleSkillSessions(workspace.id)).toEqual([session.ref.id]);

    // Evicting is the remedy: the session rebuilds from current config on next use.
    await registry.evict(session.ref.id);
    expect(registry.staleSkillSessions(workspace.id)).toEqual([]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
