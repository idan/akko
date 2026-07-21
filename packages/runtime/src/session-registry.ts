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
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import {
  AllowAllPolicy,
  type AuthorizationPolicy,
  type Command,
  type ConversationStore,
  type Decision,
  type EventBus,
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
import { AkkoSessionRuntime, type SessionDriver } from "./session-runtime.ts";
import { InMemorySessionIndex, type SessionIndex } from "./session-index.ts";
import type { SessionProjector } from "./session-projector.ts";
import { newSessionId } from "./ids.ts";

export interface AkkoSessionRegistryDeps {
  workspaceRuntimeFactory: WorkspaceRuntimeFactory;
  conversationStore: ConversationStore;
  eventBus: EventBus;
  sessionIndex?: SessionIndex;
  policy?: AuthorizationPolicy;
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

  constructor(deps: AkkoSessionRegistryDeps) {
    this.#deps = deps;
    this.#policy = deps.policy ?? new AllowAllPolicy();
    this.#index = deps.sessionIndex ?? new InMemorySessionIndex();
  }

  registerWorkspace(workspace: Workspace): void {
    this.#workspaces.set(workspace.id, workspace);
  }

  async get(sessionId: SessionId): Promise<AkkoSessionRuntime> {
    const live = this.#live.get(sessionId);
    if (live) return live;

    // Lazy rehydration: rebuild a disposed/cold session from durable state.
    const ref = this.#index.getRef(sessionId);
    if (!ref) throw new Error(`unknown session: ${sessionId}`);
    const wr = await this.#workspaceRuntime(ref.workspaceId);
    const sessionManager = await this.#deps.conversationStore.load(sessionId);
    const { session } = await this.#buildSession(wr, sessionManager);
    return this.#instantiate(ref, session, session.messages.length);
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
  }): Promise<AkkoSessionRuntime> {
    const wr = await this.#workspaceRuntime(input.workspaceId);
    const sessionId = newSessionId();
    const sessionManager = await this.#deps.conversationStore.create(sessionId);
    const { session } = await this.#buildSession(wr, sessionManager);

    const now = Date.now();
    const ref: SessionRef = {
      id: sessionId,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      kind: "conversation",
      title: input.title,
      hostNode: (this.#deps.nodeId ?? "local") as SessionRef["hostNode"],
      createdAt: now,
      updatedAt: now,
    };
    this.#index.upsertRef(ref);
    this.#deps.projector?.ensureSession(ref);
    return this.#instantiate(ref, session, 0);
  }

  async spawnSubagent(_options: SpawnSubagentOptions): Promise<AkkoSessionRuntime> {
    throw new Error("spawnSubagent not implemented in slice 1");
  }

  async list(workspaceId: WorkspaceId, _principalId: PrincipalId): Promise<SessionRef[]> {
    return this.#index.listRefs(workspaceId);
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

  #buildSession(wr: WorkspaceRuntime, sessionManager: Awaited<ReturnType<ConversationStore["create"]>>) {
    return createAgentSession({
      cwd: wr.execution.cwd,
      agentDir: wr.agentDir,
      modelRuntime: wr.modelRuntime,
      settingsManager: wr.settingsManager,
      resourceLoader: wr.resourceLoader,
      sessionManager,
    });
  }

  #instantiate(ref: SessionRef, session: SessionDriver, persistedCount: number): AkkoSessionRuntime {
    const projector = this.#deps.projector;
    if (projector) projector.ensureSession(ref);
    const runtime = new AkkoSessionRuntime({
      ref,
      driver: session,
      eventBus: this.#deps.eventBus,
      conversationStore: this.#deps.conversationStore,
      persistedCount,
      entrySinks: projector ? [projector] : [],
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
    return this.#policy.authorize(
      { principal: { id: command.actorId, kind: "user", displayName: command.actorId } },
      { kind: "command", verb: command.verb },
      { type: "session", session: ref },
    );
  }
}
