/**
 * The `spawn_subagent` tool contract (doc 03). These cover the parts that bite:
 * refusals must not leak concurrency slots, failures must still release + evict, and the
 * child must be driven through its mailbox rather than poked directly.
 */
import { describe, expect, test } from "bun:test";
import type { PrincipalId, SessionId, WorkspaceId } from "@akko/core";
import { InMemoryEventBus } from "../src/event-bus.ts";
import { SubagentLimiter } from "../src/subagent-limits.ts";
import { createSpawnSubagentTool, runSubagentToCompletion } from "../src/subagent-tool.ts";

const PARENT = "ses_parent" as SessionId;
const WORKSPACE = "wsp_1" as WorkspaceId;
const ACTOR = "prn_human" as PrincipalId;

/** A fake registry that records spawns/evictions and hands back a stub child. */
function fakeRegistry(childId = "ses_child") {
  const spawned: Array<Record<string, unknown>> = [];
  const evicted: string[] = [];
  return {
    spawned,
    evicted,
    async spawnSubagent(options: Record<string, unknown>) {
      spawned.push(options);
      return { ref: { id: childId as SessionId, ownerId: ACTOR }, mailbox: { post: async () => ({ accepted: true }) } } as never;
    },
    async evict(id: SessionId) {
      evicted.push(id);
    },
  };
}

function makeTool(over: Partial<Parameters<typeof createSpawnSubagentTool>[0]> = {}) {
  const registry = fakeRegistry();
  const limiter = new SubagentLimiter({ perParent: 1, global: 5, maxDepth: 1 });
  const tool = createSpawnSubagentTool({
    registry: registry as never,
    limiter,
    parentSessionId: PARENT,
    workspaceId: WORKSPACE,
    actorId: ACTOR,
    eventBus: new InMemoryEventBus(),
    runChild: async () => "the answer",
    ...over,
  });
  return { tool, registry, limiter };
}

describe("spawn_subagent tool", () => {
  test("spawns a child, returns its output, then releases the slot and evicts it", async () => {
    const { tool, registry, limiter } = makeTool();

    const result = await tool.execute("t1", { task: "count the docs" }, undefined);

    expect(result.content[0]).toMatchObject({ type: "text", text: "the answer" });
    expect(registry.spawned).toHaveLength(1);
    expect(registry.spawned[0]).toMatchObject({
      parentSessionId: PARENT,
      workspaceId: WORKSPACE,
      actorId: ACTOR, // attributed to the human, not a service principal
      prompt: "count the docs",
    });
    // Slot released and liveness disposed — the transcript stays durable.
    expect(limiter.running(PARENT)).toBe(0);
    expect(registry.evicted).toEqual(["ses_child"]);
  });

  test("refuses past the cap with a reason the model can act on, and spawns nothing", async () => {
    const { tool, registry, limiter } = makeTool();
    limiter.admit(PARENT, 1); // occupy the only slot

    await expect(tool.execute("t1", { task: "another" }, undefined)).rejects.toThrow(
      /subagent limit \(1\)/,
    );
    expect(registry.spawned).toHaveLength(0);
    expect(limiter.running(PARENT)).toBe(1); // the refusal didn't consume a slot
  });

  test("a failing child still releases its slot and evicts (no leak on the error path)", async () => {
    const { tool, registry, limiter } = makeTool({
      runChild: async () => {
        throw new Error("model exploded");
      },
    });

    await expect(tool.execute("t1", { task: "boom" }, undefined)).rejects.toThrow("model exploded");

    // This is the important assertion: a leaked slot would wedge spawning permanently.
    expect(limiter.running(PARENT)).toBe(0);
    expect(registry.evicted).toEqual(["ses_child"]);
  });

  test("an empty task is rejected before any slot is taken", async () => {
    const { tool, registry, limiter } = makeTool();
    await expect(tool.execute("t1", { task: "   " }, undefined)).rejects.toThrow("`task` is required");
    expect(limiter.running(PARENT)).toBe(0);
    expect(registry.spawned).toHaveLength(0);
  });

  test("empty child output is reported rather than returned as an empty string", async () => {
    const { tool } = makeTool({ runChild: async () => "" });
    const result = await tool.execute("t1", { task: "quiet" }, undefined);
    expect(result.content[0]).toMatchObject({ text: "(the subagent produced no output)" });
  });

  test("passes an optional model override and title through to the spawn", async () => {
    const { tool, registry } = makeTool();
    await tool.execute("t1", { task: "x", model: "haiku", title: "Docs audit" }, undefined);
    expect(registry.spawned[0]).toMatchObject({ model: "haiku", title: "Docs audit" });
  });
});

describe("runSubagentToCompletion", () => {
  /** A child stub whose mailbox emits a scripted pi stream on the bus. */
  function childOn(bus: InMemoryEventBus, script: () => void, accepted = true, reason?: string) {
    const id = "ses_child" as SessionId;
    return {
      ref: { id, ownerId: ACTOR },
      mailbox: {
        post: async () => {
          queueMicrotask(script);
          return { accepted, reason };
        },
      },
    } as never;
  }

  test("accumulates streamed text and resolves at agent_end", async () => {
    const bus = new InMemoryEventBus();
    const child = childOn(bus, () => {
      const emit = (event: unknown) => bus.publish({ type: "pi", sessionId: "ses_child" as SessionId, event } as never);
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
      emit({ type: "agent_end" });
    });

    await expect(runSubagentToCompletion(child, bus, "go")).resolves.toBe("hello world");
  });

  test("rejects when the child's mailbox refuses the prompt", async () => {
    const bus = new InMemoryEventBus();
    const child = childOn(bus, () => {}, false, "session is busy");
    await expect(runSubagentToCompletion(child, bus, "go")).rejects.toThrow("session is busy");
  });

  test("times out rather than pinning a slot on a wedged child", async () => {
    const bus = new InMemoryEventBus();
    const child = childOn(bus, () => {}); // never emits agent_end
    await expect(runSubagentToCompletion(child, bus, "go", undefined, 25)).rejects.toThrow(
      /timed out/,
    );
  });

  test("aborts when the parent's turn is cancelled", async () => {
    const bus = new InMemoryEventBus();
    const controller = new AbortController();
    const child = childOn(bus, () => controller.abort());
    await expect(runSubagentToCompletion(child, bus, "go", controller.signal)).rejects.toThrow(
      "aborted",
    );
  });
});
