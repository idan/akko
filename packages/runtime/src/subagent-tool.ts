/**
 * The `spawn_subagent` pi tool (doc 03) — how the *model* delegates.
 *
 * A parent conversation gets this tool; subagents do not, so delegation cannot nest.
 * The call **blocks** until the child finishes and returns its final text, which keeps
 * the contract simple: one tool call in, one answer out, no orphan lifecycle to manage.
 * The child is a real session throughout, so switching to an async/fleet model later
 * changes who delivers the result, not the model underneath.
 *
 * Refusals (concurrency caps) `throw`. pi's agent loop catches tool exceptions and turns
 * them into an error tool result the model reads and can act on — it does *not* abort the
 * turn — so throwing is both the idiomatic path and the one that keeps this code simple.
 */
import { Type } from "typebox";
import type { EventBus, PrincipalId, SessionId, WorkspaceId } from "@akko/core";
import type { AkkoSessionRuntime } from "./session-runtime.ts";
import type { SubagentLimiter } from "./subagent-limits.ts";

/** How long a single subagent may run before we stop waiting for it. */
export const SUBAGENT_TIMEOUT_MS = 10 * 60_000;

export interface SpawnSubagentToolDeps {
  registry: {
    spawnSubagent(options: {
      parentSessionId: SessionId;
      workspaceId: WorkspaceId;
      actorId: PrincipalId;
      agentType?: string;
      prompt: string;
      model?: string;
      title?: string;
    }): Promise<AkkoSessionRuntime>;
    evict(sessionId: SessionId): Promise<void>;
  };
  limiter: SubagentLimiter;
  parentSessionId: SessionId;
  workspaceId: WorkspaceId;
  actorId: PrincipalId;
  /** Agent-type presets to advertise, so the model knows what it may ask for. */
  agentTypes?: () => string;
  /**
   * Apply an agent-type preset's instructions to a task. The registry owns the presets,
   * but the tool owns the prompt, so resolution is injected rather than duplicated.
   */
  preparePrompt?: (task: string, agentType?: string) => string;
  /** Where the child's stream is observed — the same bus the projector reads. */
  eventBus: EventBus;
  /** Test seam: run the child and resolve with its final text. */
  runChild?: (child: AkkoSessionRuntime, prompt: string, signal?: AbortSignal) => Promise<string>;
  /** How long one unit waits for a concurrency slot before giving up. Test seam. */
  slotWaitMs?: number;
  /**
   * Provider the child will run on, for the per-provider cap. A function because the
   * parent's model can change mid-session (`setModel`), and a per-call override wins.
   */
  getProvider?: (modelOverride?: string) => string | undefined;
}

/** Build the tool-result shape pi expects. */
const textResult = (text: string, details: { sessionId?: string } = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const parameters = Type.Object({
  tasks: Type.Array(
    Type.Object({
      task: Type.String({
        description:
          "One complete, self-contained unit of work. The subagent cannot see this conversation, so include every detail it needs and say exactly what to return.",
      }),
      title: Type.Optional(
        Type.String({ description: "Short label for this subagent, shown in the UI." }),
      ),
      agentType: Type.Optional(
        Type.String({
          description:
            "Optional named preset to run this unit as (see the tool description for what is available).",
        }),
      ),
    }),
    {
      description:
        "One entry per independent unit of work (e.g. one file each). They run in parallel, so prefer many small entries over one large one.",
      minItems: 1,
    },
  ),
  model: Type.Optional(
    Type.String({ description: "Optional model override; defaults to this session's model." }),
  ),
});

interface TaskSpec {
  task: string;
  title?: string;
  /** Named agent-type preset (doc 03) — configures model, tools and instructions. */
  agentType?: string;
  /** Batch-level model override, copied onto each unit so spawns stay uniform. */
  model?: string;
}

/** One finished unit of work, in the order it was requested. */
interface TaskOutcome {
  index: number;
  title?: string;
  output: string;
  failed: boolean;
  sessionId?: string;
}

/** How long a single unit waits for a concurrency slot before giving up. */
const SLOT_WAIT_TIMEOUT_MS = 60_000;
const SLOT_POLL_MS = 250;

/**
 * Drive a child session to completion and collect its assistant output.
 *
 * Resolves when the child's turn ends. Rejects on timeout so a wedged child cannot pin a
 * concurrency slot (and the parent's turn) indefinitely.
 */
export function runSubagentToCompletion(
  child: AkkoSessionRuntime,
  eventBus: EventBus,
  prompt: string,
  signal?: AbortSignal,
  timeoutMs: number = SUBAGENT_TIMEOUT_MS,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let text = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error(`subagent timed out after ${Math.round(timeoutMs / 1000)}s`))),
      timeoutMs,
    );
    const onAbort = () => finish(() => reject(new Error("subagent aborted")));
    signal?.addEventListener("abort", onAbort);

    // Observe the child on the event bus rather than the driver: the runtime already
    // republishes pi's stream there, and it is the same source the projector consumes.
    const unsubscribe = eventBus.subscribe(child.ref.id, (domainEvent) => {
      if (domainEvent.type !== "pi") return;
      const pi = (domainEvent as { event?: { type: string; assistantMessageEvent?: { type: string; delta?: string } } }).event;
      if (!pi) return;
      if (pi.type === "message_update" && pi.assistantMessageEvent?.type === "text_delta") {
        text += pi.assistantMessageEvent.delta ?? "";
      }
      if (pi.type === "agent_end") finish(() => resolve(text.trim()));
    });

    // Through the mailbox, so the child is serialized and attributed like any session.
    child.mailbox
      .post({
        id: `cmd_sub_${Date.now()}` as never,
        sessionId: child.ref.id,
        actorId: child.ref.ownerId,
        verb: "prompt",
        args: { text: prompt },
        ts: Date.now(),
      })
      .then((result) => {
        if (!result.accepted) finish(() => reject(new Error(result.reason ?? "subagent prompt rejected")));
      })
      .catch((error) => finish(() => reject(error)));
  });
}

export function createSpawnSubagentTool(deps: SpawnSubagentToolDeps) {
  const run =
    deps.runChild ?? ((child, prompt, signal) => runSubagentToCompletion(child, deps.eventBus, prompt, signal));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Reserve a slot, waiting for one if the caps are currently full.
   *
   * Waiting here does not reintroduce the deadlock we rejected earlier: subagents cannot
   * spawn (depth 1), so every slot holder is doing real work and will finish. The wait is
   * also bounded, so a saturated system degrades to a per-item error rather than a hang.
   */
  async function acquireSlot(
    provider: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ release?: () => void } | string> {
    const deadline = Date.now() + (deps.slotWaitMs ?? SLOT_WAIT_TIMEOUT_MS);
    for (;;) {
      const admission = deps.limiter.admit(deps.parentSessionId, 1, provider);
      if (admission.allowed) return admission;
      if (signal?.aborted) return "aborted before a subagent slot became free";
      if (Date.now() >= deadline) return admission.reason;
      await sleep(SLOT_POLL_MS);
    }
  }

  /** Run one unit of work end to end. Never throws: a failure is that unit's result. */
  async function runOne(
    spec: TaskSpec,
    index: number,
    provider: string | undefined,
    signal?: AbortSignal,
  ): Promise<TaskOutcome> {
    const slot = await acquireSlot(provider, signal);
    if (typeof slot === "string") {
      return { index, title: spec.title, output: `not started: ${slot}`, failed: true };
    }
    let childId: string | undefined;
    try {
      const child = await deps.registry.spawnSubagent({
        parentSessionId: deps.parentSessionId,
        workspaceId: deps.workspaceId,
        actorId: deps.actorId,
        prompt: spec.task,
        title: spec.title,
        model: spec.model,
        agentType: spec.agentType,
      });
      childId = child.ref.id;
      const prompt = deps.preparePrompt?.(spec.task, spec.agentType) ?? spec.task;
      const output = await run(child, prompt, signal);
      return {
        index,
        title: spec.title,
        output: output || "(no output)",
        failed: false,
        sessionId: childId,
      };
    } catch (error) {
      // One bad subagent must not discard the other nineteen results.
      return {
        index,
        title: spec.title,
        output: `failed: ${error instanceof Error ? error.message : String(error)}`,
        failed: true,
        sessionId: childId,
      };
    } finally {
      slot.release?.();
      if (childId) await deps.registry.evict(childId as never).catch(() => {});
    }
  }

  return {
    name: "spawn_subagent",
    label: "Spawn subagents",
    description:
      (deps.agentTypes?.() ? `Available agent types: ${deps.agentTypes()}. ` : "") +
      "Delegate independent units of work to subagents, each with its own fresh context window, and wait for their answers. " +
      "Pass one entry per unit (e.g. one file each) in `tasks` — they run in parallel, so a list of twenty is one call, not twenty. " +
      "Best for work that would otherwise flood this conversation with detail you don't need verbatim: summarizing or auditing many " +
      "files, searching a large codebase, or exploring several approaches. Each subagent cannot see this conversation and cannot " +
      "delegate further, so every entry must be complete and self-contained and say exactly what to return.",
    // pi prefixes this with the tool name, so don't repeat it here.
    promptSnippet: "delegate independent units of work to parallel subagents with fresh context windows",
    // Without these the model sees the tool listed but is given no reason to reach for it,
    // and simply does the work inline — which is what happened in practice.
    promptGuidelines: [
      "When a request breaks into independent units of work (e.g. per-file summaries or audits), delegate them with spawn_subagent instead of doing each one inline.",
      "Enumerate the units yourself first — a quick ls/find/grep is cheap — then pass one `tasks` entry per unit in a single spawn_subagent call. They run in parallel; do not collapse the whole job into one entry.",
      "Prefer spawn_subagent whenever completing a task means reading a lot of material you won't need verbatim afterwards; keep this conversation for the synthesis.",
    ],
    parameters,
    executionMode: "parallel" as const,
    /**
     * Accept the single-task shape too. Models reach for `{task, title}` from habit, and
     * a schema rejection would cost a whole retry round-trip to say so.
     */
    prepareArguments(args: unknown) {
      const a = (args ?? {}) as Record<string, unknown>;
      if (!a.tasks && typeof a.task === "string") {
        return { tasks: [{ task: a.task, title: a.title }], model: a.model };
      }
      return a;
    },
    async execute(
      _toolCallId: string,
      params: { tasks: TaskSpec[]; model?: string },
      signal?: AbortSignal,
    ) {
      const tasks = (params.tasks ?? []).filter((t) => t?.task?.trim());
      if (tasks.length === 0) throw new Error("spawn_subagent: at least one task is required.");

      // Report progress: a batch can hold the turn for minutes without emitting a token,
      // so without this the UI sits on a static "19 tasks" label and looks stalled.
      const label = tasks.length === 1 ? (tasks[0]!.title ?? "subagent") : `${tasks.length} subagents`;
      let done = 0;
      const report = () =>
        deps.eventBus.publish({
          type: "progress",
          sessionId: deps.parentSessionId,
          label,
          done,
          total: tasks.length,
        });
      report();

      // Bounded concurrency is enforced by the limiter via acquireSlot, so simply start
      // them all: the slots throttle, and results come back in request order.
      const provider = deps.getProvider?.(params.model);
      const outcomes = await Promise.all(
        tasks.map((t, i) =>
          runOne({ ...t, model: params.model }, i, provider, signal).then((outcome) => {
            done += 1;
            report();
            return outcome;
          }),
        ),
      );

      const body = outcomes
        .sort((a, b) => a.index - b.index)
        .map((o) => `## ${o.title ?? `Task ${o.index + 1}`}${o.failed ? " (failed)" : ""}\n${o.output}`)
        .join("\n\n");
      const failed = outcomes.filter((o) => o.failed).length;
      const header =
        outcomes.length > 1
          ? `${outcomes.length} subagents finished${failed ? `, ${failed} failed` : ""}.\n\n`
          : "";

      // Every unit failing is a tool failure; a partial failure is reported in the body.
      if (failed === outcomes.length) throw new Error(`All ${failed} subagent(s) failed.\n\n${body}`);

      return {
        content: [{ type: "text" as const, text: header + body }],
        details: { sessionIds: outcomes.map((o) => o.sessionId).filter(Boolean) },
      };
    },
  };
}
