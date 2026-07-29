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
    slotWaitMs: 50, // tests must not sit on the real 60s slot wait
    ...over,
  });
  return { tool, registry, limiter };
}

describe("spawn_subagent tool", () => {
  test("spawns a child, returns its output, then releases the slot and evicts it", async () => {
    const { tool, registry, limiter } = makeTool();

    const result = await tool.execute("t1", { tasks: [{ task: "count the docs" }] }, undefined);

    expect(result.content[0]!.text).toContain("the answer");
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

  test("waits briefly for a slot, then reports the unit as not started", async () => {
    const { tool, registry, limiter } = makeTool();
    limiter.admit(PARENT, 1); // occupy the only slot

    // The tool now *waits* for a slot rather than refusing instantly — safe because
    // subagents cannot spawn, so every slot holder is doing work that finishes. The wait
    // is bounded, so saturation degrades to an error, never a hang. With one task, that
    // one failing means the whole call failed.
    await expect(tool.execute("t1", { tasks: [{ task: "another" }] }, undefined)).rejects.toThrow(
      /not started.*subagent limit \(1\)/s,
    );
    expect(registry.spawned).toHaveLength(0);
    expect(limiter.running(PARENT)).toBe(1); // the wait didn't consume a slot
  });

  test("a failing child still releases its slot and evicts (no leak on the error path)", async () => {
    const { tool, registry, limiter } = makeTool({
      runChild: async () => {
        throw new Error("model exploded");
      },
    });

    // Sole task failing => the whole call fails.
    await expect(tool.execute("t1", { tasks: [{ task: "boom" }] }, undefined)).rejects.toThrow("model exploded");

    // This is the important assertion: a leaked slot would wedge spawning permanently.
    expect(limiter.running(PARENT)).toBe(0);
    expect(registry.evicted).toEqual(["ses_child"]);
  });

  test("an empty task is rejected before any slot is taken", async () => {
    const { tool, registry, limiter } = makeTool();
    await expect(tool.execute("t1", { tasks: [{ task: "   " }] }, undefined)).rejects.toThrow("at least one task");
    expect(limiter.running(PARENT)).toBe(0);
    expect(registry.spawned).toHaveLength(0);
  });

  test("empty child output is reported rather than returned as an empty string", async () => {
    const { tool } = makeTool({ runChild: async () => "" });
    const result = await tool.execute("t1", { tasks: [{ task: "quiet" }] }, undefined);
    expect(result.content[0]!.text).toContain("(no output)");
  });

  test("passes an optional model override and title through to the spawn", async () => {
    const { tool, registry } = makeTool();
    await tool.execute("t1", { tasks: [{ task: "x", title: "Docs audit" }], model: "haiku" }, undefined);
    expect(registry.spawned[0]).toMatchObject({ title: "Docs audit" });
  });
});

describe("spawn_subagent batching", () => {
  test("runs a list of units in parallel and labels each result", async () => {
    // The whole point of the batch shape: "handle all of them at once" IS the fan-out,
    // so the model gets parallelism without having to be disciplined about it.
    const registry = fakeRegistry();
    const limiter = new SubagentLimiter({ perParent: 3, global: 8, maxDepth: 1 });
    let concurrent = 0;
    let peak = 0;
    const tool = createSpawnSubagentTool({
      registry: registry as never,
      limiter,
      parentSessionId: PARENT,
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      eventBus: new InMemoryEventBus(),
      slotWaitMs: 2_000,
      runChild: async (_c, prompt) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent -= 1;
        return `summary of ${prompt}`;
      },
    });

    const result = await tool.execute(
      "t1",
      { tasks: [1, 2, 3, 4, 5].map((n) => ({ task: `doc${n}.md`, title: `Doc ${n}` })) },
      undefined,
    );

    const text = result.content[0]!.text;
    expect(text).toContain("5 subagents finished");
    for (const n of [1, 2, 3, 4, 5]) {
      expect(text).toContain(`## Doc ${n}`);
      expect(text).toContain(`summary of doc${n}.md`);
    }
    expect(registry.spawned).toHaveLength(5);
    expect(peak).toBeGreaterThan(1); // genuinely concurrent...
    expect(peak).toBeLessThanOrEqual(3); // ...but never past the cap
    expect(limiter.running(PARENT)).toBe(0); // every slot returned
  });

  test("one failing unit does not discard the others", async () => {
    const registry = fakeRegistry();
    const tool = createSpawnSubagentTool({
      registry: registry as never,
      limiter: new SubagentLimiter({ perParent: 3, global: 8, maxDepth: 1 }),
      parentSessionId: PARENT,
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      eventBus: new InMemoryEventBus(),
      runChild: async (_c, prompt) => {
        if (prompt === "bad") throw new Error("model exploded");
        return `ok: ${prompt}`;
      },
    });

    const result = await tool.execute(
      "t1",
      { tasks: [{ task: "good1" }, { task: "bad" }, { task: "good2" }] },
      undefined,
    );

    const text = result.content[0]!.text;
    expect(text).toContain("3 subagents finished, 1 failed");
    expect(text).toContain("ok: good1");
    expect(text).toContain("ok: good2");
    expect(text).toContain("model exploded"); // reported, not swallowed
  });

  test("results keep request order regardless of completion order", async () => {
    const registry = fakeRegistry();
    const tool = createSpawnSubagentTool({
      registry: registry as never,
      limiter: new SubagentLimiter({ perParent: 3, global: 8, maxDepth: 1 }),
      parentSessionId: PARENT,
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      eventBus: new InMemoryEventBus(),
      // Reverse the finishing order: the last task returns first.
      runChild: async (_c, prompt) => {
        await new Promise((r) => setTimeout(r, prompt === "first" ? 40 : 5));
        return `done ${prompt}`;
      },
    });

    const result = await tool.execute(
      "t1",
      { tasks: [{ task: "first", title: "A" }, { task: "second", title: "B" }] },
      undefined,
    );
    const text = result.content[0]!.text;
    expect(text.indexOf("## A")).toBeLessThan(text.indexOf("## B"));
  });

  test("prepareArguments accepts the single-task shape models reach for by habit", () => {
    const { tool } = makeTool();
    expect(tool.prepareArguments?.({ task: "do a thing", title: "T" })).toEqual({
      tasks: [{ task: "do a thing", title: "T" }],
      model: undefined,
    });
    // Already-correct arguments pass through untouched.
    const batch = { tasks: [{ task: "a" }, { task: "b" }] };
    expect(tool.prepareArguments?.(batch)).toEqual(batch);
  });
});

describe("spawn_subagent prompting", () => {
  test("ships guidelines telling the model when to delegate", () => {
    // Without these the tool is merely *listed*: the model sees it exists but is given no
    // reason to prefer it, and does the work inline instead. pi injects promptGuidelines
    // into the system prompt's Guidelines section.
    const { tool } = makeTool();
    expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
    const guidance = (tool.promptGuidelines ?? []).join(" ");
    expect(guidance).toMatch(/independent/i); // the trigger condition
    expect(guidance).toMatch(/parallel/i); // and that several calls can run at once
  });

  test("guidance says to enumerate first and scope one subagent per unit", () => {
    // Observed failure: asked to summarize every doc, the model delegated
    // "find all the docs and summarize each" to ONE subagent — it could not fan out
    // because it had not enumerated the files yet. One serial child defeats the point.
    const { tool } = makeTool();
    const guidance = (tool.promptGuidelines ?? []).join(" ");
    expect(guidance).toMatch(/enumerate/i);
    expect(guidance).toMatch(/one `tasks` entry per unit/i);
    expect(tool.description).toMatch(/one entry per unit/i);
  });

  test("the snippet does not repeat the tool name (pi already prefixes it)", () => {
    const { tool } = makeTool();
    expect(tool.promptSnippet?.startsWith("spawn_subagent")).toBe(false);
  });

  test("the description tells the model the task must be self-contained", () => {
    const { tool } = makeTool();
    expect(tool.description).toMatch(/self-contained/i);
    expect(tool.description).toMatch(/cannot see this conversation/i);
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
