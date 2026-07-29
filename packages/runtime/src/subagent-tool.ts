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
  /** Where the child's stream is observed — the same bus the projector reads. */
  eventBus: EventBus;
  /** Test seam: run the child and resolve with its final text. */
  runChild?: (child: AkkoSessionRuntime, prompt: string, signal?: AbortSignal) => Promise<string>;
}

/** Build the tool-result shape pi expects. */
const textResult = (text: string, details: { sessionId?: string } = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const parameters = Type.Object({
  task: Type.String({
    description:
      "The complete, self-contained task for the subagent. It does not see this conversation, so include every detail it needs.",
  }),
  title: Type.Optional(
    Type.String({ description: "Short label for this subagent, shown in the UI." }),
  ),
  model: Type.Optional(
    Type.String({ description: "Optional model override; defaults to this session's model." }),
  ),
});

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

  return {
    name: "spawn_subagent",
    label: "Spawn subagent",
    description:
      "Delegate a self-contained task to a subagent with its own fresh context window, and wait for its answer. " +
      "Use this for work that would flood this conversation with detail you don't need to keep — searching, " +
      "auditing many files, or exploring an approach. The subagent cannot see this conversation and cannot " +
      "delegate further, so the task must be complete on its own.",
    promptSnippet: "spawn_subagent: delegate a self-contained task to a fresh-context subagent",
    parameters,
    // Parallel so the model can fan out several children in one turn, bounded by the caps.
    executionMode: "parallel" as const,
    async execute(
      _toolCallId: string,
      params: { task: string; title?: string; model?: string },
      signal?: AbortSignal,
    ) {
      const task = params.task?.trim();
      if (!task) throw new Error("spawn_subagent: `task` is required.");

      // Depth 1: this tool only exists on conversations, so any call is a first-level spawn.
      const admission = deps.limiter.admit(deps.parentSessionId, 1);
      if (!admission.allowed) throw new Error(`Cannot spawn a subagent: ${admission.reason}`);

      let childId: SessionId | undefined;
      try {
        const child = await deps.registry.spawnSubagent({
          parentSessionId: deps.parentSessionId,
          workspaceId: deps.workspaceId,
          actorId: deps.actorId,
          prompt: task,
          model: params.model,
          title: params.title,
        });
        childId = child.ref.id;
        const output = await run(child, task, signal);
        return textResult(output || "(the subagent produced no output)", { sessionId: childId });
      } finally {
        // Free the slot before evicting, so a slow dispose can't wedge admission. Runs on
        // the throw path too — a failed child must not leak its slot.
        admission.release?.();
        // Liveness only — the child's transcript stays durable and inspectable (doc 04).
        if (childId) await deps.registry.evict(childId).catch(() => {});
      }
    },
  };
}
