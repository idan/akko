/**
 * AkkoSessionRegistry — `SessionRegistry` with durable refs + lazy rehydration
 * (doc 03/04).
 *
 * Maps session id -> live `AkkoSessionRuntime`. `createConversation` builds the pi
 * session via `createAgentSession` and persists its `SessionRef` to the `SessionIndex`.
 * `get` rehydrates a non-live session: it looks up the ref, rebuilds the conversation
 * from the `ConversationStore`, and constructs a fresh runtime — the durable/liveness
 * split in action. `list` reads from the durable index, not just live memory.
 */
import { join } from "node:path";
import { createAgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AllowAllPolicy,
  type AuthorizationPolicy,
  type Command,
  type ConversationStore,
  type Decision,
  type EntrySink,
  type EventBus,
  type ModelCatalogEntry,
  type PrincipalId,
  type SessionId,
  type SessionRef,
  type SessionKind,
  type SessionRegistry,
  type SpawnSubagentOptions,
  type Workspace,
  type WorkspaceId,
  type WorkspaceRuntime,
  type WorkspaceRuntimeFactory,
} from "@akko/core";
import { AkkoMailbox } from "./mailbox.ts";
import { AkkoModelRouter, modelRef } from "./model-router.ts";
import { AkkoSessionRuntime, type SessionDriver } from "./session-runtime.ts";
import { InMemorySessionIndex, type SessionIndex } from "./session-index.ts";
import type { MembershipStore } from "./membership-store.ts";
import type { SessionProjector } from "./session-projector.ts";
import { limitsFromEnv, providerOf, SubagentLimiter, type SubagentLimits } from "./subagent-limits.ts";
import { createSpawnSubagentTool } from "./subagent-tool.ts";
import { applyAgentType, describeAgentTypes, loadAgentTypes, type AgentType } from "./agent-types.ts";
import { newSessionId, newCommandId } from "./ids.ts";

export interface AkkoSessionRegistryDeps {
  workspaceRuntimeFactory: WorkspaceRuntimeFactory;
  conversationStore: ConversationStore;
  eventBus: EventBus;
  sessionIndex?: SessionIndex;
  policy?: AuthorizationPolicy;
  /** Source of principal→workspace roles for `authorize()` (doc 16). */
  memberships?: MembershipStore;
  /** Optional read-model projector (e.g. Jazz). Fed committed entries; owns projection ids. */
  projector?: SessionProjector;
  /** This node's id, stamped onto `SessionRef.hostNode`. */
  nodeId?: string;
  /** Subagent concurrency caps (doc 03). Defaults come from the environment. */
  subagentLimits?: SubagentLimits;
  /**
   * Directory of agent-type `.md` presets (doc 03). Defaults to `<cwd>/.akko/agents`.
   * Loaded once at construction: presets are developer-authored config, not user data.
   */
  agentTypesDir?: string;
}

/**
 * Index bookkeeping run as an entry sink: keep `updatedAt` fresh as a conversation grows
 * and refresh the projected session row, so a reactive session list orders by real
 * recency (doc 14). Separate from the projector because it is index work, not projection.
 */
export function createSessionTouchSink(deps: {
  sessionId: SessionId;
  index: SessionIndex;
  projector?: SessionProjector;
}): EntrySink {
  return {
    onEntry: async () => {
      deps.index.touch(deps.sessionId, Date.now());
      const cur = deps.index.getRef(deps.sessionId);
      if (cur) deps.projector?.projectSessionMeta?.(cur);
    },
  };
}

export class AkkoSessionRegistry implements SessionRegistry {
  #live = new Map<SessionId, AkkoSessionRuntime>();
  #workspaces = new Map<WorkspaceId, Workspace>();
  readonly #deps: AkkoSessionRegistryDeps;
  readonly #policy: AuthorizationPolicy;
  readonly #index: SessionIndex;
  readonly #router = new AkkoModelRouter();
  readonly #subagents: SubagentLimiter;
  readonly #agentTypes: Map<string, AgentType>;

  constructor(deps: AkkoSessionRegistryDeps) {
    this.#deps = deps;
    this.#policy = deps.policy ?? new AllowAllPolicy();
    this.#index = deps.sessionIndex ?? new InMemorySessionIndex();
    this.#subagents = new SubagentLimiter(deps.subagentLimits ?? limitsFromEnv());
    this.#agentTypes = loadAgentTypes(deps.agentTypesDir ?? join(process.cwd(), ".akko", "agents"));
  }

  /** Workspace runtime bundle — used by services that need the resource loader (doc 06). */
  async workspaceRuntimeFor(workspaceId: WorkspaceId): Promise<WorkspaceRuntime> {
    return this.#workspaceRuntime(workspaceId);
  }

  /** A throwaway session purely for system-prompt preview (doc 06). */
  async previewSession(workspaceId: WorkspaceId): Promise<{ systemPrompt: string }> {
    const wr = await this.#workspaceRuntime(workspaceId);
    const sessionManager = await this.#deps.conversationStore.create(newSessionId());
    const { session } = await this.#buildSession(wr, sessionManager, undefined, {
      id: newSessionId(),
      ownerId: "prn_preview" as PrincipalId,
      kind: "conversation",
    });
    return { systemPrompt: session.systemPrompt };
  }

  /** Agent-type presets available for `spawnSubagent` (doc 03). */
  agentTypes(): Map<string, AgentType> {
    return this.#agentTypes;
  }

  /** In-flight subagent count (all parents, or one). Exposed for tests + diagnostics. */
  runningSubagents(parentSessionId?: SessionId): number {
    return this.#subagents.running(parentSessionId);
  }

  registerWorkspace(workspace: Workspace): void {
    this.#workspaces.set(workspace.id, workspace);
    // Make the read model complete at boot: project metadata for every session already
    // in the durable index, so the reactive session list isn't limited to sessions this
    // process happens to touch. Metadata only — history backfill stays lazy (doc 14).
    const projector = this.#deps.projector;
    if (projector?.projectSessionMeta) {
      for (const ref of this.#index.listRefs(workspace.id)) projector.projectSessionMeta(ref);
    }
  }

  /**
   * Ensure a session's read-model projection exists (metadata + history backfill + live
   * subscription) **without** rehydrating it into a live pi session.
   *
   * Backfill needs only canonical entries, so viewing a cold session must not pay for a
   * `createAgentSession`. Called when a client opens a session: the projection is
   * disposable (doc 04) and the dev sync server is in-memory, so after any restart the
   * session list comes back from metadata while the messages do not exist yet. Without
   * this, a session looks empty until someone sends a command to it.
   */
  async ensureProjected(sessionId: SessionId): Promise<boolean> {
    const ref = this.#index.getRef(sessionId);
    if (!ref) return false;
    this.#deps.projector?.ensureSession(ref);
    return true;
  }

  async get(sessionId: SessionId): Promise<AkkoSessionRuntime> {
    const live = this.#live.get(sessionId);
    if (live) return live;

    // Lazy rehydration: rebuild a disposed/cold session from durable state.
    const ref = this.#index.getRef(sessionId);
    if (!ref) throw new Error(`unknown session: ${sessionId}`);
    const wr = await this.#workspaceRuntime(ref.workspaceId);
    const sessionManager = await this.#deps.conversationStore.load(sessionId);
    // Re-apply the persisted model choice (doc 05), if it still resolves.
    let initialModel: Model<Api> | undefined;
    if (ref.model) {
      const resolved = this.#router.resolveModelString(ref.model, wr.modelRuntime);
      if (typeof resolved !== "string") initialModel = resolved;
    }
    // Pass the ref's own identity/kind so a rehydrated conversation keeps exactly the
    // tools it had when created.
    const { session } = await this.#buildSession(wr, sessionManager, initialModel, ref);
    return this.#instantiate(ref, session, session.messages.length, wr.modelRuntime);
  }

  isLive(sessionId: SessionId): boolean {
    return this.#live.has(sessionId);
  }

  /** External projection id (e.g. Jazz CoValue id) for a session, if a projector is set. */
  projectionId(sessionId: SessionId): string | undefined {
    return this.#deps.projector?.projectionId(sessionId);
  }

  async createConversation(input: {
    workspaceId: WorkspaceId;
    ownerId: PrincipalId;
    title?: string;
    model?: string;
  }): Promise<AkkoSessionRuntime> {
    const wr = await this.#workspaceRuntime(input.workspaceId);
    const sessionId = newSessionId();
    const sessionManager = await this.#deps.conversationStore.create(sessionId);

    // Resolve an optional requested model up front so a bad string fails the create.
    let initialModel: Model<Api> | undefined;
    if (input.model) {
      const resolved = this.#router.resolveModelString(input.model, wr.modelRuntime);
      if (typeof resolved === "string") throw new Error(`model "${input.model}": ${resolved}`);
      initialModel = resolved;
    }
    const { session } = await this.#buildSession(wr, sessionManager, initialModel, {
      id: sessionId,
      ownerId: input.ownerId,
      kind: "conversation",
    });

    const now = Date.now();
    const ref: SessionRef = {
      id: sessionId,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      kind: "conversation",
      title: input.title,
      model: session.model ? modelRef(session.model) : undefined,
      hostNode: (this.#deps.nodeId ?? "local") as SessionRef["hostNode"],
      createdAt: now,
      updatedAt: now,
    };
    this.#index.upsertRef(ref);
    this.#deps.projector?.ensureSession(ref);
    return this.#instantiate(ref, session, 0, wr.modelRuntime);
  }

  /** Available models for a workspace (doc 05) — powers the UI picker and the classifier. */
  async listModels(workspaceId: WorkspaceId): Promise<ModelCatalogEntry[]> {
    const wr = await this.#workspaceRuntime(workspaceId);
    return this.#router.catalog(wr.modelRuntime);
  }

  /**
   * Spawn a subagent as an ordinary session (doc 03): same registry, same mailbox, same
   * authorization gate, `kind: "subagent"` plus a `parentSessionId`. Nothing about it is
   * a special path — which is what makes it persist, project and rehydrate for free.
   *
   * Attribution stays with the **initiating human** (`actorId`) rather than a service
   * principal, so workspace membership and the role policy apply unchanged; provenance
   * lives in `parentSessionId`.
   *
   * Callers are responsible for concurrency admission (see `SubagentLimiter`); this
   * method creates what it is asked to create.
   */
  async spawnSubagent(options: SpawnSubagentOptions): Promise<AkkoSessionRuntime> {
    const parent = this.#index.getRef(options.parentSessionId);
    if (!parent) throw new Error(`unknown parent session: ${options.parentSessionId}`);
    if (parent.workspaceId !== options.workspaceId) {
      throw new Error("subagent must live in the same workspace as its parent");
    }

    const wr = await this.#workspaceRuntime(options.workspaceId);
    const sessionId = newSessionId();
    const sessionManager = await this.#deps.conversationStore.create(sessionId);

    const agentType = options.agentType ? this.#agentTypes.get(options.agentType) : undefined;
    if (options.agentType && !agentType) {
      throw new Error(
        `unknown agent type "${options.agentType}"; available: ${[...this.#agentTypes.keys()].join(", ") || "(none)"}`,
      );
    }

    // Precedence: explicit override > the preset's model > the parent's. Inheriting last
    // means delegation doesn't silently change the model the user chose.
    const requested = options.model ?? agentType?.model ?? parent.model;
    let initialModel: Model<Api> | undefined;
    if (requested) {
      const resolved = this.#router.resolveModelString(requested, wr.modelRuntime);
      if (typeof resolved !== "string") initialModel = resolved;
    }

    // `canSpawn: false` withholds the spawn tool from the child. Depth is enforced by
    // absence of the capability rather than by a counter the model could talk its way
    // around (the limiter's depth check is a backstop).
    const { session } = await this.#buildSession(
      wr,
      sessionManager,
      initialModel,
      { id: sessionId, ownerId: options.actorId, kind: "subagent" },
      agentType,
    );

    const now = Date.now();
    const ref: SessionRef = {
      id: sessionId,
      workspaceId: options.workspaceId,
      ownerId: options.actorId,
      kind: "subagent",
      parentSessionId: options.parentSessionId,
      title: options.title ?? options.agentType ?? "subagent",
      agentType: options.agentType,
      model: session.model ? modelRef(session.model) : undefined,
      hostNode: (this.#deps.nodeId ?? "local") as SessionRef["hostNode"],
      createdAt: now,
      updatedAt: now,
    };
    this.#index.upsertRef(ref);
    this.#deps.projector?.ensureSession(ref);
    return this.#instantiate(ref, session, 0, wr.modelRuntime);
  }

  /**
   * Stop a running subagent (doc 03). Aborts its live turn; the transcript stays durable,
   * so a stopped child is inspectable rather than erased.
   *
   * `parentSessionId` scopes the authority: a session may only stop *its own* children,
   * which keeps this safe to expose as a command without a second permission model.
   */
  async stopSubagent(sessionId: SessionId, parentSessionId?: SessionId): Promise<boolean> {
    const ref = this.#index.getRef(sessionId);
    if (!ref || ref.kind !== "subagent") return false;
    if (parentSessionId && ref.parentSessionId !== parentSessionId) {
      throw new Error("cannot stop a subagent belonging to another session");
    }
    const live = this.#live.get(sessionId);
    if (!live) return false; // already finished or evicted; nothing to stop
    await live.applyCommand({
      id: newCommandId(),
      sessionId,
      actorId: ref.ownerId,
      verb: "abort",
      args: {},
      ts: Date.now(),
    });
    return true;
  }

  async list(workspaceId: WorkspaceId, _principalId: PrincipalId): Promise<SessionRef[]> {
    // Subagents are sessions, but they are not *conversations* — surfacing them would
    // litter the sidebar with one row per delegated turn. The data is all there if we
    // later decide to render them nested under their parent (doc 15, C8).
    return this.#index.listRefs(workspaceId).filter((r) => r.kind === "conversation");
  }

  /** Cheap metadata lookup from the durable index (no rehydration). */
  async getRef(sessionId: SessionId): Promise<SessionRef | undefined> {
    return this.#index.getRef(sessionId);
  }

  /** Canonical conversation history for a session, read straight from the store. */
  async getEntries(sessionId: SessionId) {
    const ref = this.#index.getRef(sessionId);
    if (!ref) throw new Error(`unknown session: ${sessionId}`);
    // Reading history is also the moment a client is about to render this session, so
    // make sure the read-model projection exists for it (cheap; backfills once). Without
    // this, selecting a session that isn't live leaves the projection empty (doc 14).
    this.#deps.projector?.ensureSession(ref);
    return this.#deps.conversationStore.getEntries(sessionId);
  }

  async evict(sessionId: SessionId): Promise<void> {
    const live = this.#live.get(sessionId);
    if (!live) return;
    await live.dispose();
    this.#live.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    for (const runtime of this.#live.values()) await runtime.dispose();
    this.#live.clear();
  }

  async #workspaceRuntime(workspaceId: WorkspaceId): Promise<WorkspaceRuntime> {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) throw new Error(`unknown workspace: ${workspaceId}`);
    return this.#deps.workspaceRuntimeFactory.get(workspace);
  }

  /**
   * Build the pi session for a ref. **Every** path that constructs a session goes through
   * here — create, rehydrate and subagent-spawn — so the tool set cannot diverge between
   * them. It did once: `spawn_subagent` was attached only on create, so any rehydrated
   * session silently lost it while the model still saw earlier successful calls in its
   * transcript and kept calling a tool that no longer existed.
   */
  #buildSession(
    wr: WorkspaceRuntime,
    sessionManager: Awaited<ReturnType<ConversationStore["create"]>>,
    model: Model<Api> | undefined,
    forSession: { id: SessionId; ownerId: PrincipalId; kind: SessionKind },
    agentType?: AgentType,
  ) {
    // Conversations may delegate; subagents may not, which is what makes nesting
    // impossible by construction (doc 03). Derived from `kind` rather than passed in, so
    // the rule lives in one place.
    const customTools =
      forSession.kind === "conversation"
        ? [
            createSpawnSubagentTool({
              registry: this,
              limiter: this.#subagents,
              parentSessionId: forSession.id,
              workspaceId: wr.workspace.id,
              actorId: forSession.ownerId,
              eventBus: this.#deps.eventBus,
              // Resolved per call: the parent's model can change mid-session, and a
              // per-batch override takes precedence.
              getProvider: (override) =>
                providerOf(override ?? this.#index.getRef(forSession.id)?.model),
              agentTypes: () => describeAgentTypes(this.#agentTypes),
              preparePrompt: (task, agentType) =>
                applyAgentType(agentType ? this.#agentTypes.get(agentType) : undefined, task),
            }),
          ]
        : undefined;
    return createAgentSession({
      cwd: wr.execution.cwd,
      agentDir: wr.agentDir,
      modelRuntime: wr.modelRuntime,
      settingsManager: wr.settingsManager,
      resourceLoader: wr.resourceLoader,
      sessionManager,
      model,
      ...(customTools ? { customTools } : {}),
      // An agent type may restrict the child's tools ("researcher" reads but cannot write)
      // and pick a cheaper thinking level.
      ...(agentType?.tools ? { tools: agentType.tools } : {}),
      ...(agentType?.thinkingLevel ? { thinkingLevel: agentType.thinkingLevel as never } : {}),
    });
  }

  #instantiate(
    ref: SessionRef,
    session: SessionDriver,
    persistedCount: number,
    modelRuntime: ModelRuntime,
  ): AkkoSessionRuntime {
    const projector = this.#deps.projector;
    if (projector) projector.ensureSession(ref);
    const touchSink = createSessionTouchSink({ sessionId: ref.id, index: this.#index, projector });
    const runtime = new AkkoSessionRuntime({
      ref,
      driver: session,
      eventBus: this.#deps.eventBus,
      conversationStore: this.#deps.conversationStore,
      persistedCount,
      entrySinks: projector ? [projector, touchSink] : [touchSink],
      resolveModel: (input) => this.#router.resolveModelString(input, modelRuntime),
      // Scoped to this session's own children, so the verb needs no extra permission model.
      stopSubagent: (childId) => this.stopSubagent(childId as SessionId, ref.id),
      onRenamed: (title) => {
        const cur = this.#index.getRef(ref.id);
        if (!cur) return;
        const next = { ...cur, title, updatedAt: Date.now() };
        this.#index.upsertRef(next);
        this.#deps.projector?.projectSessionMeta?.(next);
      },
      onModelChanged: (modelId) => {
        const cur = this.#index.getRef(ref.id);
        if (!cur) return;
        const next = { ...cur, model: modelId, updatedAt: Date.now() };
        this.#index.upsertRef(next);
        // Refresh the projected session row so the reactive session list picks up the
        // new model without a socket patch (doc 14).
        this.#deps.projector?.ensureSession(next);
      },
    });
    const mailbox = new AkkoMailbox({
      authorize: (command) => this.#authorize(ref, command),
      apply: (command) => runtime.applyCommand(command),
    });
    runtime.attachMailbox(mailbox);
    this.#live.set(ref.id, runtime);
    return runtime;
  }

  #authorize(ref: SessionRef, command: Command): Decision | Promise<Decision> {
    const role = this.#deps.memberships?.roleFor(ref.workspaceId, command.actorId);
    return this.#policy.authorize(
      {
        principal: { id: command.actorId, kind: "user", displayName: command.actorId },
        role,
      },
      { kind: "command", verb: command.verb },
      { type: "session", session: ref },
    );
  }
}
