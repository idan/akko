/**
 * Model routing (doc 05).
 *
 * Two distinct problems, one pipeline:
 *   1. String -> Model  : fuzzy-resolve a human-ish model string to a concrete Model.
 *   2. Task   -> Model  : a cheap classifier picks a model for a task description.
 * Pipeline: task -> routeTask() -> name string -> resolveModelString() -> Model.
 *
 * Both operate against the CALLER's available models (per-workspace `ModelRegistry`),
 * so routing respects each tenant's entitlements by construction.
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** A compact, LLM-friendly description of one available model, built from the runtime. */
export interface ModelCatalogEntry {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** A task-routing request. */
export interface RouteRequest {
  /** Natural-language description of the task to route. */
  task: string;
  /** Optional hints: latency/cost preference, required modalities, min context, etc. */
  hints?: {
    prefer?: "speed" | "cost" | "quality";
    needsImages?: boolean;
    minContextWindow?: number;
    needsReasoning?: boolean;
  };
}

/** The router's decision. `model` is a name string, resolved downstream. */
export interface RouteDecision {
  /** Chosen model as a string (fed to `resolveModelString`). */
  model: string;
  thinkingLevel: ThinkingLevel;
  /** Short rationale, surfaced in advisory mode (doc 05). */
  reason: string;
}

export interface ModelRouter {
  /**
   * Fuzzy string resolution: exact `provider/id` > id substring > name substring >
   * all-parts-present, with separator normalization and optional date tokens. Matches
   * only against available (authed) models. Returns the `Model` or an error string.
   * (Reimplements the algorithm proven in `@tintinweb/pi-subagents`.)
   */
  resolveModelString(input: string, runtime: ModelRuntime): Model<Api> | string;

  /** Build the catalog handed to the classifier, from the caller's model runtime. */
  catalog(runtime: ModelRuntime): Promise<ModelCatalogEntry[]>;

  /**
   * Natural-language task routing: classify the task against the catalog (typically a
   * cheap Haiku-class call) and return a model name + thinking level + rationale.
   */
  routeTask(request: RouteRequest, runtime: ModelRuntime): Promise<RouteDecision>;
}

/**
 * When the router runs (doc 05). Policy, not architecture — the interface supports all
 * three; the mailbox/frontend choose the active mode.
 */
export type RoutingMode = "automatic" | "advisory" | "agent-driven";

export const DEFAULT_ROUTING: { conversation: RoutingMode; subagent: RoutingMode } = {
  conversation: "advisory",
  subagent: "agent-driven",
};
