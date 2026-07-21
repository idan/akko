/**
 * WorkspaceRuntime — the bridge from Akko's `Workspace` to pi's per-call parameters.
 *
 * The load-bearing fact (doc 01): `createAgentSession()` takes `cwd`, `authStorage`,
 * `modelRegistry`, `sessionManager`, `settingsManager`, and `resourceLoader` as
 * **per-call parameters**, not process globals. Tenancy is therefore just "what
 * bundle do we pass in for this workspace". This module is that bundle plus the two
 * seams (credentials, isolation) that let it stay single-user simple now and go
 * multiuser later without a rearchitecture.
 *
 * See `docs/architecture/02-tenancy-and-identity.md` and `09-security-and-isolation.md`.
 */

import type {
  ModelRuntime,
  ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SessionId, Workspace } from "./domain.ts";

/**
 * Per-tenant credential + model access. Single shared instance today; per-workspace
 * files or a vault later. Separated out because "which models can this tenant use"
 * feeds model routing (doc 05) and must be per-tenant by construction.
 *
 * pi's `ModelRuntime` unifies credential storage and the model catalog/availability
 * (it replaced the separate `AuthStorage` + `ModelRegistry`). It is built per
 * workspace with a workspace-scoped `authPath`/`modelsPath`, or hub-brokered
 * inference (doc 12).
 */
export interface CredentialProvider {
  /** Build (or return cached) model runtime scoped to a workspace. */
  for(workspace: Workspace): Promise<{ modelRuntime: ModelRuntime }>;
}

/**
 * Describes where and how tool execution runs for a workspace. Today `host` returns a
 * plain cwd. Later `container` returns routed operations (or the caller runs the whole
 * process inside the boundary). The one rule: nothing outside this may assume "the
 * host filesystem" — execution is always resolved here (doc 09).
 */
export interface WorkspaceExecution {
  isolation: "host" | "container";
  /** Working directory pi tools operate against. */
  cwd: string;
  /**
   * Optional overrides that route built-in tools/`!` commands into an isolated
   * environment (Gondolin-style). When absent, pi's default local execution is used.
   * Left as `unknown` here to avoid over-committing to pi's `BashOperations`/tool op
   * shapes in the design skeleton.
   */
  bashOps?: unknown;
  fsOps?: unknown;
}

/**
 * The resolved, ready-to-use pi parameter bundle for one workspace. Produced by a
 * `WorkspaceRuntimeFactory`. A `SessionRuntime` (see `session-runtime.ts`) consumes
 * this to call `createAgentSession`.
 */
export interface WorkspaceRuntime {
  workspace: Workspace;
  execution: WorkspaceExecution;

  /**
   * Unified model + credential runtime for this workspace (pi's `ModelRuntime`).
   * Drives `createAgentSession({ modelRuntime })` and feeds the router's per-tenant
   * catalog via `getAvailable()` (doc 05).
   */
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;

  /**
   * Resource loader carrying this workspace's skills/extensions/prompts. Note pi
   * extensions are **session-scoped**: each `AgentSession` must bind them and rebind
   * after session replacement (doc 01/03).
   */
  resourceLoader: ResourceLoader;

  /**
   * The pi agent config dir for this workspace (skills/prompts/settings discovery
   * root). Distinct from `execution.cwd`, which is where tools operate.
   */
  agentDir: string;

  /**
   * Build a `SessionManager` for a given session. Which concrete storage this uses
   * (JSONL file, in-memory + mirror, or a custom `SessionStorage`) is an
   * implementation detail hidden behind the `ConversationStore` (doc 04); this
   * returns whatever pi object `createAgentSession` needs.
   */
  sessionManagerFor(sessionId: SessionId): Promise<SessionManager>;
}

/**
 * Creates (and typically caches) a `WorkspaceRuntime` per workspace. This is the
 * single place that knows how a `Workspace` becomes pi parameters, so isolation and
 * credential strategy changes land here and nowhere else.
 */
export interface WorkspaceRuntimeFactory {
  get(workspace: Workspace): Promise<WorkspaceRuntime>;
  /** Release cached runtime resources for a workspace (e.g. on eviction/shutdown). */
  release(workspaceId: Workspace["id"]): Promise<void>;
}
