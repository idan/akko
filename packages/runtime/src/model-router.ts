/**
 * AkkoModelRouter — the `ModelRouter` seam (doc 05), slice 1: string resolution.
 *
 * Slice 1 implements `resolveModelString` (human-ish string -> concrete `Model`) and
 * `catalog` (the available-models list the UI picker and, later, the classifier use).
 * Rather than reimplement the fuzzy matcher, we delegate to pi's own `resolveCliModel`
 * so Akko's matching stays identical to pi's (exact `provider/id` > id/name partials,
 * separator + date normalization), against the caller's authed models only.
 *
 * `routeTask` (natural-language task -> model) is slice 2 and throws until built.
 */
import { resolveCliModel, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelCatalogEntry, ModelRouter, RouteDecision, RouteRequest } from "@akko/core";

/** Canonical, unambiguous reference for a model: `provider/id`. */
export function modelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export class AkkoModelRouter implements ModelRouter {
  resolveModelString(input: string, runtime: ModelRuntime): Model<Api> | string {
    const result = resolveCliModel({ cliModel: input, modelRuntime: runtime });
    if (result.model) return result.model;
    return result.error ?? result.warning ?? `no model matches "${input}"`;
  }

  async catalog(runtime: ModelRuntime): Promise<ModelCatalogEntry[]> {
    const models = await runtime.getAvailable();
    return models.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: [...m.input],
      contextWindow: m.contextWindow,
      cost: {
        input: m.cost.input,
        output: m.cost.output,
        cacheRead: m.cost.cacheRead,
        cacheWrite: m.cost.cacheWrite,
      },
    }));
  }

  async routeTask(_request: RouteRequest, _runtime: ModelRuntime): Promise<RouteDecision> {
    throw new Error("routeTask: natural-language task routing is slice 2 (doc 05)");
  }
}
