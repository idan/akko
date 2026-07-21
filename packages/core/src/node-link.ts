/**
 * Node ↔ Hub link protocol (doc 12).
 *
 * One persistent, bidirectional, multiplexed connection carrying four logical
 * channels. This is the wire form of our existing seams made remote:
 *   - command : Hub → node   — attributed mailbox items (`Mailbox` remote)
 *   - entry   : node → Hub   — durable, cursored replication (`EntrySink` remote)
 *   - event   : node → Hub   — ephemeral live streaming (`EventBus` remote)
 *   - control : both         — register / heartbeat / capabilities
 *
 * Transport is a persistent WebSocket to start (gRPC optional later). Deliberately NOT
 * Jazz: session streams are single-writer append-only logs, not multi-writer CRDTs,
 * and Jazz stays the Hub→client projection only (doc 04/12).
 */

import type { CommittedEntry } from "./conversation-store.ts";
import type { Command, CommandId, NodeId, SessionId } from "./domain.ts";
import type { DomainEvent } from "./events.ts";
import type { MailboxResult } from "./session-runtime.ts";
import type { NodeAuth, NodeRegistration } from "./node.ts";
import type { ReplicationCursor } from "./replication.ts";

/** control channel — connection lifecycle. */
export type ControlMessage =
  | { ch: "control"; t: "register"; registration: NodeRegistration; auth: NodeAuth }
  | { ch: "control"; t: "registered"; nodeId: NodeId }
  | { ch: "control"; t: "register_rejected"; reason: string }
  | { ch: "control"; t: "heartbeat"; nodeId: NodeId; ts: number; activeSessions?: number };

/** command channel — Hub delivers attributed mailbox items; node acks the result. */
export type CommandMessage =
  | { ch: "command"; t: "deliver"; command: Command }
  | { ch: "command"; t: "ack"; commandId: CommandId; result: MailboxResult };

/** entry channel — node replicates committed entries; Hub acks the advanced cursor. */
export type EntryMessage =
  | { ch: "entry"; t: "append"; sessionId: SessionId; entry: CommittedEntry }
  | { ch: "entry"; t: "ack"; cursor: ReplicationCursor }
  /** node asks where to resume from after reconnect. */
  | { ch: "entry"; t: "resume_from"; sessionId: SessionId };

/** event channel — ephemeral live streaming (deltas, tool activity) for clients. */
export type EventMessage = { ch: "event"; event: DomainEvent };

export type NodeLinkMessage = ControlMessage | CommandMessage | EntryMessage | EventMessage;

/**
 * The transport handle used by both ends. Implementations wrap a WebSocket (or gRPC
 * stream) and handle framing/reconnection. Higher layers (command router, replication
 * client/sink, event fan-out) speak only `NodeLinkMessage`.
 */
export interface NodeLink {
  send(message: NodeLinkMessage): void;
  onMessage(handler: (message: NodeLinkMessage) => void): () => void;

  readonly connected: boolean;
  /** Notified on connect/disconnect so the node can trigger cursor-based resend. */
  onStatus(handler: (connected: boolean) => void): () => void;

  close(): void;
}
