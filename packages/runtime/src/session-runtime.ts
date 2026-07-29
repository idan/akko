/**
 * AkkoSessionRuntime — owns one live session and is its single writer (doc 03/04).
 *
 * It drives the session through a narrow `SessionDriver` (satisfied structurally by
 * pi's `AgentSession`, and by a fake in tests), fans pi events out to the `EventBus`,
 * captures committed conversation entries into the durable `ConversationStore`, and is
 * the `apply` target for the mailbox.
 *
 * Two important details:
 *  - A `prompt` on an idle session resolves *acceptance* early (via pi's
 *    `preflightResult`) rather than waiting for the whole run, so the mailbox keeps
 *    applying steering commands while the run streams.
 *  - Entry capture diffs `session.messages` after each turn and persists new messages,
 *    attributing user messages to the actor of the most recent input command.
 */
import type {
  AgentSession,
  AgentSessionEvent,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  Command,
  CommittedEntry,
  ConversationStore,
  EntrySink,
  EventBus,
  Mailbox,
  PrincipalId,
  SessionRef,
  SessionRuntime,
} from "@akko/core";
import { newEntryId } from "./ids.ts";

/** The subset of pi's `AgentSession` the runtime uses. */
export interface SessionDriver {
  readonly isStreaming: boolean;
  readonly messages: AgentMessage[];
  /** Currently selected model (undefined until one is chosen). */
  readonly model?: Model<Api>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  setModel(model: Model<Api>): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

interface PromptArgs {
  text: string;
  streamingBehavior?: "steer" | "followUp";
}

export interface AkkoSessionRuntimeOptions {
  ref: SessionRef;
  driver: SessionDriver;
  eventBus: EventBus;
  conversationStore: ConversationStore;
  /** Number of messages already persisted (nonzero after rehydration). */
  persistedCount?: number;
  /** Extra sinks fed each committed entry (e.g. a Jazz projector). */
  entrySinks?: EntrySink[];
  /** Resolve a human-ish model string to a concrete model (doc 05). */
  resolveModel?: (input: string) => Model<Api> | string;
  /** Called after a successful model change, with the canonical `provider/id`. */
  onModelChanged?: (modelRef: string) => void;
  /** Called after a successful rename so the index + read model can be updated. */
  onRenamed?: (title: string) => void;
}

export class AkkoSessionRuntime implements SessionRuntime {
  readonly ref: SessionRef;
  readonly #driver: SessionDriver;
  readonly #eventBus: EventBus;
  readonly #store: ConversationStore;
  readonly #entrySinks: EntrySink[];
  readonly #resolveModel?: (input: string) => Model<Api> | string;
  readonly #onModelChanged?: (modelRef: string) => void;
  readonly #onRenamed?: (title: string) => void;
  #unsubscribe?: () => void;
  #mailbox!: Mailbox;

  #persistedCount: number;
  #lastEntryId: string | null = null;
  #lastActor?: PrincipalId;
  #lastTs = 0;
  #captureChain: Promise<void> = Promise.resolve();

  constructor(options: AkkoSessionRuntimeOptions) {
    this.ref = options.ref;
    this.#driver = options.driver;
    this.#eventBus = options.eventBus;
    this.#store = options.conversationStore;
    this.#entrySinks = options.entrySinks ?? [];
    this.#resolveModel = options.resolveModel;
    this.#onModelChanged = options.onModelChanged;
    this.#onRenamed = options.onRenamed;
    this.#persistedCount = options.persistedCount ?? 0;
    this.#unsubscribe = this.#driver.subscribe((event) => {
      this.#eventBus.publish({ type: "pi", sessionId: this.ref.id, event });
      if (event.type === "turn_end" || event.type === "agent_end") this.#scheduleCapture();
    });
  }

  attachMailbox(mailbox: Mailbox): void {
    this.#mailbox = mailbox;
  }

  get mailbox(): Mailbox {
    return this.#mailbox;
  }

  get session(): AgentSession {
    return this.#driver as unknown as AgentSession;
  }

  isBusy(): boolean {
    return this.#driver.isStreaming || this.#mailbox.size() > 0;
  }

  async applyCommand(command: Command): Promise<void> {
    switch (command.verb) {
      case "prompt":
        this.#lastActor = command.actorId;
        return this.#applyPrompt(command.args as PromptArgs);
      case "steer":
        this.#lastActor = command.actorId;
        return this.#driver.steer((command.args as { text: string }).text);
      case "followUp":
        this.#lastActor = command.actorId;
        return this.#driver.followUp((command.args as { text: string }).text);
      case "setModel":
        return this.#applySetModel((command.args as { model: string }).model);
      case "abort":
        return this.#driver.abort();
      case "rename":
        return this.#applyRename((command.args as { title?: string }).title ?? "");
      default:
        throw new Error(`verb not implemented in slice 1: ${command.verb}`);
    }
  }

  #applyPrompt(args: PromptArgs): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const options: PromptOptions = {
        preflightResult: (accepted) =>
          accepted ? resolve() : reject(new Error("prompt rejected by preflight")),
      };
      if (this.#driver.isStreaming) {
        options.streamingBehavior = args.streamingBehavior ?? "followUp";
      }
      this.#driver.prompt(args.text, options).catch(reject);
    });
  }

  /** Resolve a model string and apply it to the live session, then persist + broadcast. */
  async #applySetModel(input: string): Promise<void> {
    if (!input) throw new Error("setModel: missing model");
    const resolved = this.#resolveModel?.(input);
    if (!resolved) throw new Error("setModel: no model resolver configured");
    if (typeof resolved === "string") throw new Error(resolved); // resolver's error message
    await this.#driver.setModel(resolved);
    const ref = `${resolved.provider}/${resolved.id}`;
    this.#onModelChanged?.(ref);
    // Broadcast to every subscribed client (cross-tab) via the generic session patch.
    this.#eventBus.publish({ type: "session", sessionId: this.ref.id, patch: { model: ref } });
  }

  /**
   * Rename the session. Purely metadata: it never touches the pi driver, but it goes
   * through the mailbox like any other command so it is attributed and authorized on the
   * same path (doc 03).
   */
  async #applyRename(input: string): Promise<void> {
    const title = input.trim();
    if (!title) throw new Error("rename: missing title");
    if (title.length > 200) throw new Error("rename: title too long");
    this.#onRenamed?.(title);
    this.#eventBus.publish({ type: "session", sessionId: this.ref.id, patch: { title } });
  }

  /** Serialize captures so overlapping turn/agent_end events cannot double-persist. */
  #scheduleCapture(): void {
    this.#captureChain = this.#captureChain.then(() => this.#capture()).catch(() => {});
  }

  async #capture(): Promise<void> {
    const messages = this.#driver.messages;
    for (let i = this.#persistedCount; i < messages.length; i++) {
      const message = messages[i]!;
      const id = newEntryId();
      // Strictly increasing: a turn's user + assistant messages are captured in the same
      // tick, so a plain Date.now() ties and any consumer that orders by `ts` gets an
      // arbitrary order (the Jazz read model sorts by it, which put replies before
      // prompts). Monotonic timestamps preserve pi's message order.
      const ts = Math.max(Date.now(), this.#lastTs + 1);
      this.#lastTs = ts;
      const entry: CommittedEntry = {
        id,
        parentId: this.#lastEntryId as CommittedEntry["parentId"],
        entry: message,
        actorId: message.role === "user" ? this.#lastActor : undefined,
        ts,
      };
      await this.#store.persistEntry(this.ref.id, entry);
      this.#eventBus.publish({ type: "entry", sessionId: this.ref.id, entry });
      for (const sink of this.#entrySinks) {
        try {
          await sink.onEntry(this.ref.id, entry);
        } catch (error) {
          // A projection failure must not break canonical capture (doc 04) — but log it,
          // don't swallow silently, so read-model bugs are diagnosable.
          console.error(`[runtime] entry sink failed for ${this.ref.id}:`, error);
        }
      }
      this.#lastEntryId = id;
    }
    this.#persistedCount = messages.length;
  }

  async dispose(): Promise<void> {
    await this.#captureChain;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#driver.dispose();
  }
}
