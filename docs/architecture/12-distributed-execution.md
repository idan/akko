# 12 — Distributed Execution

General agentic chat can run anywhere, but **coding work must run where the code
is** — which may not be the machine hosting the backend. Akko therefore supports
installing a **daemon** on other machines that register as execution points. A
session can run **locally** (next to the backend) or **remotely** (on a daemon that
has the codebase checked out), while canonical state still lives centrally.

This is an *implementation of seams already in the design* (`HostResolver`, the
mailbox actor model, the durable/liveness split, the `ConversationStore` seam), plus
one new component (the daemon) and one new protocol (node↔Hub). It is not a
rearchitecture.

## Locked decisions

1. **Consistency: node-local write-ahead + async replication** (model B).
2. **Canonical ownership: the host node is the single writer; the Hub is a
   replica / queryable-canonical-when-cold.**
3. **Transport: a purpose-built node↔Hub link (WebSocket now, gRPC optional later);
   Jazz stays the client projection only.**
4. **Placement by workspace** (where the code is). Subagents are pinned to their
   parent's node.
5. **Inference: hub-brokered is the target; node-holds-keys is the acceptable
   starting point.**

## Three roles

"The backend" is split into a coordinating role and an executing role:

| Role | Responsibility | Count |
|---|---|---|
| **Hub** | Directory (session→node), ACL, index, client gateway, command routing, aggregate canonical/replica SQLite, model/credential brokering | 1 |
| **SessionHost** (daemon) | Runs pi `AgentSession`s on a local filesystem, drains mailboxes, durably logs its sessions' entries (write-ahead), replicates entries + streams live events to the Hub, registers/heartbeats | N |
| **Clients** | Browsers; connect only to the Hub | many |

The **Hub machine also runs a co-located SessionHost** (the "local node"). So a
*local session* is one hosted on that co-located host; a *remote session* is one
hosted on a remote daemon. Same code path, different node — there is no special
"remote mode", only placement.

```
   browsers ──WS──▶  ┌─────────── HUB ───────────┐
                     │ directory (session→node)  │
                     │ ACL / index / router      │◀── canonical/replica SQLite
                     │ client gateway  ─▶ Jazz projection (doc 04/08)
                     └───▲───────────────▲───────┘
        node↔Hub link ───┘               └─── node↔Hub link
             │                                │
   ┌─────────┴──────────┐          ┌──────────┴─────────┐
   │ SessionHost (local)│          │ SessionHost (remote│
   │ pi AgentSessions   │          │  daemon, near code)│
   │ write-ahead log    │          │ pi AgentSessions   │
   │ filesystem = code  │          │ write-ahead log    │
   └────────────────────┘          │ filesystem = code  │
                                    └────────────────────┘
```

## Single-writer, relocated

The invariant from doc 04 is preserved, just moved:

> The **host node is the single writer** for the sessions it hosts. The Hub **never
> writes session content** — it ingests replicated entries. The Hub's SQLite is
> canonical when a session is cold and a queryable replica while it is live.

This is what makes cross-node listing, ACL, serving disconnected clients, and backup
work without introducing a second writer. Your "the backend has the SQLite" model
holds: the Hub is the queryable canonical store; the node adds a durable log so it
can keep working during a partition.

### Why this is easy: append-only log shipping

pi sessions are an **append-only tree of entries with stable ids** — already an event
log. Replicating node→Hub is **log shipping with a cursor**: idempotent by `EntryId`,
resumable after disconnect. We are not syncing mutable state; we are shipping a linear
log. This is the single most important reason the distributed model is low-risk.

## Consistency model B: write-ahead + async replicate

1. As the agent produces committed entries, the host **appends to a local durable log**
   (crash- and partition-safe) and applies them to the live session.
2. A **replication client** streams entries to the Hub as connectivity allows.
3. The Hub **ingests idempotently** (by `EntryId`) and **acks a cursor** (`lastEntryId`
   per session).
4. On reconnect, the node resends from its last-acked cursor. Exactly-once by id.

The node-local store can be minimal — a durable append log per hosted session plus a
replication cursor, **not** a full query engine. The Hub remains the queryable
canonical DB. A running coding session therefore makes progress through network blips
and reconciles automatically.

## Node ↔ Hub protocol

A persistent, bidirectional, **multiplexed** link with four logical channels:

| Channel | Direction | Durability | Purpose |
|---|---|---|---|
| **control** | both | — | register, heartbeat, capabilities, workspace attach |
| **command** | Hub→node (+ack) | at-least-once | deliver attributed mailbox items; node acks result |
| **entry** | node→Hub (+ack) | **durable, cursored** | replicate committed entries; Hub acks cursor |
| **event** | node→Hub | ephemeral | live streaming deltas / tool activity for clients |

This is precisely our `Mailbox` + `EntrySink` + `EventBus` seams made remote.
Reconnection is trivial because the entry channel is a cursored append-only log.

### Why not Jazz for this link

Jazz is a **multi-writer CRDT** sync system; our session stream is **single-writer
append-only**. A CRDT is the wrong and heavier tool for a linear log, and using Jazz
here would elevate it to canonical — contradicting doc 04's rule that Jazz is the
recreatable projection, never the source of truth. It would also couple a remote
daemon's durability to Jazz-server availability.

**Jazz stays exactly where doc 04/08 put it:** Hub→client projection + presence. The
Hub ingests entries from nodes (canonical), then projects into Jazz for browsers. The
node↔Hub link sits *upstream* of that, unchanged.

## Placement by workspace

A `Workspace` already owns the filesystem/cwd and isolation (doc 02/09). It now also
owns **location**: a workspace's code lives on a specific node (`Workspace.nodeId`;
absent = the local/hub node).

- **Sessions run on their workspace's node.** `HostResolver` resolves
  `session → workspace → node`.
- **Subagents are pinned to their parent's node** (they share the filesystem —
  essential for coding). Revisit only if a concrete need appears.
- Composes with isolation: a remote node can run its workspaces in containers
  (doc 09). "Remote" and "sandboxed" are independent axes.

## Durable storage, split

The `ConversationStore` seam (doc 04) now has two cooperating implementations:

- **Node-local write-ahead log** — durable append per hosted session + replication
  cursor; source for the entry channel; enough to rehydrate a live session locally.
- **Hub aggregate store** — ingest sink (idempotent) + the queryable canonical/replica
  SQLite the rest of the system reads (listing, ACL, serving clients, cold sessions).

Both satisfy the same conceptual contract; the new `ReplicationSource` (node) and
`ReplicationSink` (Hub) interfaces carry the cursor semantics between them.

## Inference credentials

The node's `AgentSession` calls LLM providers. Two options, target and start:

- **Target — hub-brokered inference:** point the node's `ModelRegistry` at a Hub
  inference proxy (`baseUrl`), so raw provider keys never leave the Hub. This is the
  OpenShell inference-routing pattern from doc 09 and keeps remote/untrusted daemons
  key-free.
- **Start — node-holds-keys:** the daemon holds its workspace's provider keys. Simpler
  bootstrap; acceptable until brokering lands.

Modeled as `InferenceRouting` on the workspace/credential path so switching is config,
not code.

## Daemon trust boundary (new)

A daemon is a privileged execution point running arbitrary agent tool calls on its
machine — a genuinely new trust surface beyond doc 09's per-node isolation:

- The Hub **authenticates daemons** (mutual auth / enrollment tokens).
- Each daemon **declares which workspaces it exposes**; the Hub only places sessions
  for workspaces a node has attached.
- Per-node isolation (doc 09) still governs what tool execution can do *on* that node.

## Partition behavior (policy)

- **Running session, node partitioned from Hub:** keeps running (model B), buffers
  entries, replicates on reconnect. Clients watching via the Hub see the stream pause,
  then catch up.
- **Command to an offline node:** the Hub either queues it durably for delivery on
  reconnect or rejects with "host offline" — a per-verb policy decision at the mailbox
  boundary (e.g. queue a follow-up prompt, reject an abort as stale). Default: queue
  follow-ups, reject time-sensitive verbs.
- **Migration:** moving a session to another node requires that node to have the
  workspace's code, so coding sessions are effectively pinned. Migration = cold on A
  (flush to Hub), reassign, warm on B (rehydrate from Hub replica).

## How existing seams absorb it

| Seam (already in `core`) | Distributed meaning |
|---|---|
| `HostResolver.resolve(sessionId)` | Hub directory: session→workspace→node |
| `Mailbox.post(command)` | Hub routes attributed command to the owning node's mailbox over the link |
| `ConversationStore` | Node-local write-ahead + Hub aggregate (same contract) |
| durable/liveness split | Now across machines: live session on a node, canonical/replica on the Hub |
| `WorkspaceRuntime` | Gains node placement |
| single-writer | Relocated to the host node; Hub is replica |

Genuinely new: the **daemon** component, the **node↔Hub protocol**, daemon
**enrollment/auth**, and the **replication** cursor split. See
`packages/core/src/node.ts`, `node-link.ts`, and `replication.ts`, summarized in
doc 10.
