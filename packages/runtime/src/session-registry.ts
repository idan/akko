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
import { createAgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AllowAllPolicy,
  type AuthorizationPolicy,
  type Command,
  type ConversationStore,
  type Decision,
  type EventBus,
  type ModelCatalogEntry,
  type PrincipalId,
  type SessionId,
  type SessionRef,
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
import { newSessionId } from "./ids.ts";

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
}

export class AkkoSessionRegistry implements SessionRegistry {
  #live = new Map<SessionId, AkkoSessionRuntime>();
  #workspaces = new Map<WorkspaceId, Workspace>();
  readonly #deps: AkkoSessionRegistryDeps;
  readonly #policy: AuthorizationPolicy;
  readonly #index: SessionIndex;
  readonly #router = new AkkoModelRouter();

  constructor(deps: AkkoSessionRegistryDeps) {
    this.#deps = deps;
    this.#policy = deps.policy ?? new AllowAllPolicy();
    this.#index = deps.sessionIndex ?? new InMemorySessionIndex();
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
    const { session } = await this.#buildSession(wr, sessionManager, initialModel);
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
    const { session } = await this.#buildSession(wr, sessionManager, initialModel);

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

  async spawnSubagent(_options: SpawnSubagentOptions): Promise<AkkoSessionRuntime> {
    throw new Error("spawnSubagent not implemented in slice 1");
  }

  async list(workspaceId: WorkspaceId, _principalId: PrincipalId): Promise<SessionRef[]> {
    return this.#index.listRefs(workspaceId);
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

  #buildSession(
    wr: WorkspaceRuntime,
    sessionManager: Awaited<ReturnType<ConversationStore["create"]>>,
    model?: Model<Api>,
  ) {
    return createAgentSession({
      cwd: wr.execution.cwd,
      agentDir: wr.agentDir,
      modelRuntime: wr.modelRuntime,
      settingsManager: wr.settingsManager,
      resourceLoader: wr.resourceLoader,
      sessionManager,
      model,
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
    const runtime = new AkkoSessionRuntime({
      ref,
      driver: session,
      eventBus: this.#deps.eventBus,
      conversationStore: this.#deps.conversationStore,
      persistedCount,
      entrySinks: projector ? [projector] : [],
      resolveModel: (input) => this.#router.resolveModelString(input, modelRuntime),
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
