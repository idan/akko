/**
 * GatewayConnection — transport-agnostic per-client message handling (doc 08).
 *
 * Keeps the CQRS logic independent of the WebSocket so it is unit-testable without
 * sockets: it takes a `send` sink plus the session registry and event bus. `Bun.serve`
 * (see `gateway.ts`) is a thin adapter that constructs one of these per socket.
 */
import type { Command, EventBus, Mailbox, PrincipalId, SessionId, SessionRef, WorkspaceId } from "@akko/core";
import { newCommandId } from "@akko/runtime";
import type { ClientMessage, ServerMessage } from "./protocol.ts";

/** The subset of the session registry the gateway needs (satisfied by `AkkoSessionRegistry`). */
export interface GatewaySessions {
  get(sessionId: SessionId): Promise<{ ref: SessionRef; mailbox: Mailbox }>;
  createConversation(input: {
    workspaceId: WorkspaceId;
    ownerId: PrincipalId;
    title?: string;
  }): Promise<{ ref: SessionRef; mailbox: Mailbox }>;
  list(workspaceId: WorkspaceId, principalId: PrincipalId): Promise<SessionRef[]>;
  /** Optional external projection id (e.g. Jazz CoValue id) for a session (doc 14). */
  projectionId?(sessionId: SessionId): string | undefined;
}

export interface GatewayConnectionDeps {
  principalId: PrincipalId;
  send: (message: ServerMessage) => void;
  registry: GatewaySessions;
  eventBus: EventBus;
}

export class GatewayConnection {
  readonly #deps: GatewayConnectionDeps;
  #subscriptions = new Map<string, () => void>();

  constructor(deps: GatewayConnectionDeps) {
    this.#deps = deps;
    this.#deps.send({ t: "welcome", principalId: deps.principalId });
  }

  /** Handle one raw client frame. */
  async handle(raw: string): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.#deps.send({ t: "error", message: "invalid json" });
      return;
    }
    switch (message.t) {
      case "subscribe":
        return this.#subscribe(message.sessionId);
      case "unsubscribe":
        return this.#unsubscribe(message.sessionId);
      case "command":
        return this.#command(message);
      default:
        this.#deps.send({ t: "error", message: `unknown message type` });
    }
  }

  #subscribe(sessionId: string): void {
    if (!this.#subscriptions.has(sessionId)) {
      const unsub = this.#deps.eventBus.subscribe(sessionId as SessionId, (event) =>
        this.#deps.send({ t: "event", event }),
      );
      this.#subscriptions.set(sessionId, unsub);
    }
    this.#deps.send({ t: "subscribed", sessionId });
  }

  #unsubscribe(sessionId: string): void {
    this.#subscriptions.get(sessionId)?.();
    this.#subscriptions.delete(sessionId);
  }

  async #command(message: Extract<ClientMessage, { t: "command" }>): Promise<void> {
    try {
      const runtime = await this.#deps.registry.get(message.sessionId as SessionId);
      const command: Command = {
        id: newCommandId(),
        sessionId: message.sessionId as SessionId,
        actorId: this.#deps.principalId,
        verb: message.verb,
        args: message.args ?? {},
        ts: Date.now(),
        streamingBehavior: message.streamingBehavior,
      };
      const result = await runtime.mailbox.post(command);
      this.#deps.send({ t: "ack", cid: message.cid, sessionId: message.sessionId, result });
    } catch (error) {
      this.#deps.send({
        t: "error",
        cid: message.cid,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Release all subscriptions (call on socket close). */
  close(): void {
    for (const unsub of this.#subscriptions.values()) unsub();
    this.#subscriptions.clear();
  }
}
