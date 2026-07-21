# 05 — Model Routing

"Natural-language model routing" is core to Akko: the system can take a task and
route it to an appropriate model. It is important to **not conflate two different
problems** that both look like "figure out the model".

## Two problems, one pipeline

### 1. String → Model resolution

Turn a human-ish model string (`"haiku"`, `"sonnet"`, `"claude-haiku-4.5"`) into a
concrete `Model`. This is a **fuzzy match against available models**
(`modelRegistry.getAvailable()` — only models with configured auth). Scoring:
exact id/`provider/id` > id substring > name substring > all-parts-present, with
separator normalization (dots vs dashes) and optional date-stamp tokens.

This exact algorithm already exists in `@tintinweb/pi-subagents` (`resolveModel`);
we reimplement it (~40 lines) rather than take the dependency, since it's small and
central.

### 2. Task → Model routing (the feature we actually want)

Given a **task description**, choose `{ model, thinkingLevel, reason }`. This is a
**cheap classifier call**:

- Build a **catalog** from `modelRegistry.getAvailable()`: for each model, its
  `id`, `provider`, `cost`, `contextWindow`, `reasoning`, input modalities.
- Ask a **fast, cheap model** (Haiku-class) to pick the best fit for the task,
  returning a model *name* + thinking level + rationale.
- Feed the chosen name through **string resolution (#1)** to get a concrete `Model`.
- Apply it: `session.setModel(model)` / `setThinkingLevel`, or pass it as a
  subagent's `model`.

So the pipeline is: **task → (classifier) → name string → (fuzzy resolver) →
Model → apply.**

## Per-tenant by construction

The catalog comes from the **caller's** `modelRegistry.getAvailable()`, which is the
per-workspace registry built by the `WorkspaceRuntime` (doc 02). So routing
automatically respects each tenant's entitlements/credentials with no extra work.
This is a concrete payoff of per-call parameterization (doc 01).

## Where the router lives — an open policy decision

The `ModelRouter` module is transport-agnostic; *when* it runs is policy:

| Mode | Behavior | Trade-off |
|------|----------|-----------|
| **Automatic** | Backend classifies every prompt and picks a model | Zero user effort; risk of surprising switches / classifier cost per turn |
| **Advisory** | Router suggests a model; user confirms in the UI | Transparent; adds a click |
| **Agent-driven** | A supervisor agent decides via a `route` tool | Most flexible; relies on the model to self-route |

This is left as a runtime setting rather than a hard architectural choice. The
`ModelRouter` interface supports all three; the frontend and mailbox decide which is
active. Default lean: **advisory** for user-facing conversations (transparency),
**agent-driven / automatic** for subagent spawning (the supervisor already knows the
task).

## Relationship to custom providers

pi supports custom providers and per-model routing config via `models.json`
(OpenRouter/Vercel gateway routing, proxies, local models, cost tiers, thinking-level
maps). Akko's per-workspace `modelRegistry` can layer a workspace `models.json`, so
"which providers/models exist for this tenant" is itself configurable without code.
The `ModelRouter` sees whatever that registry reports as available.

## Interfaces

See `packages/core/src/router.ts` and doc 10. Key shapes: `ModelCatalogEntry`,
`RouteRequest`, `RouteDecision`, `ModelRouter` (`resolveModelString` +
`routeTask`).
