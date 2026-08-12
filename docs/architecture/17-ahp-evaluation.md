# 17 — Agent Host Protocol Evaluation

## Decision

**Support AHP as an experimental, northbound interoperability boundary; do not pivot
Akko's core, canonical storage, first-party Jazz client, or node↔Hub replication protocol
to AHP.**

AHP is a valuable abstraction and a strong independent validation of several Akko
decisions: host authority, per-session serialization, display-ready state separated from
the agent runtime, lazy subscriptions, immutable actions/reducers, and explicit reconnect
semantics. It also gives Akko a credible path to clients we do not own (notably VS Code and
the official TypeScript/Rust/Go/Kotlin/Swift clients).

The right boundary is an **AHP adapter beside the Jazz projector**, fed by Akko's canonical
store, mailbox, and runtime events:

```text
                                      ┌─▶ JazzProjector ─▶ Jazz ─▶ Akko web app
pi AgentSession ─▶ runtime/EventBus ──┤
       ▲                              └─▶ AhpProjection/sequencer ─▶ AHP clients
       │                                          ▲
       └──────── Akko mailbox ◀───────────────────┘
                         ▲                 AHP actions → Akko commands
                         │
canonical SQLite ────────┴── rebuilds both client-facing projections
```

AHP should therefore become a supported **presentation and client-control protocol**, not
Akko's internal domain model and not its durable representation of pi state.

## Evaluation snapshot

This evaluation used:

- the published **draft specification v0.7.0**;
- `microsoft/agent-host-protocol` main at commit
  `101f8735756d7c5f239682d0265d1898542a45c9`;
- `@microsoft/agent-host-protocol` **0.7.0**;
- the specification, generated TypeScript types/reducers, official client implementation,
  and implementation list.

The project is MIT-licensed and active, but its own documentation says it is under active
development, not stabilized, and may make breaking wire/state changes. Version 0.x must be
pinned exactly and isolated behind an adapter.

Primary references:

- [What is AHP?](https://microsoft.github.io/agent-host-protocol/guide/what-is-ahp.html)
- [Specification overview](https://microsoft.github.io/agent-host-protocol/specification/overview.html)
- [Doctrine](https://microsoft.github.io/agent-host-protocol/guide/doctrine.html)
- [AHP and ACP](https://microsoft.github.io/agent-host-protocol/guide/ahp-and-acp.html)
- [GitHub repository](https://github.com/microsoft/agent-host-protocol)

## What AHP actually standardizes

AHP is the protocol between a client and an **agent host**, above the underlying agent
runtime. It does not serialize an agent's private reasoning/context/runtime object. It
serializes the display and coordination state clients need to observe and drive hosted
agent sessions.

Its main pieces are:

1. **JSON-RPC 2.0** over any reliable, ordered, bidirectional, complete-message transport.
   WebSocket is conventional, but transport selection is out of band.
2. **URI-addressed channels** (`ahp-root://`, `ahp-session:/…`, `ahp-chat:/…`, terminal,
   changeset, resource-watch, telemetry, and optional MCP channels). Every command and
   notification carries a top-level `channel` routing key.
3. **Snapshots plus ordered actions.** Each state-bearing channel has an immutable state
   tree changed only by typed actions through pure reducers.
4. **Host sequencing.** `ActionEnvelope.serverSeq` imposes server order and `origin`
   correlates an echoed action with a client's optimistic write.
5. **Write-ahead reconciliation.** Clients render confirmed state plus their pending local
   actions, then rebase when the host echoes accepted/rejected and concurrent actions.
6. **Reconnect by replay or snapshot.** A host may replay from `lastSeenServerSeq`; if its
   buffer cannot cover the gap, it returns fresh snapshots. A replay log is therefore an
   optimization, not a requirement for a first implementation.
7. **A presentation model.** Sessions, chats, turns, streaming markdown/reasoning, tool
   lifecycle, input requests, queued/steering messages, models, attachments/content refs,
   customizations, MCP state, terminals, changesets, and telemetry are typed without
   exposing a particular agent harness.
8. **Capability and protocol-version negotiation.** Clients can degrade when a host does
   not expose an optional feature.

“Transport-agnostic” needs one qualification: AHP does not choose WebSocket versus another
stream, but it still requires one ordered, reliable, bidirectional message stream. Akko's
current combination of independent HTTP command requests and Jazz replication is not an
AHP transport. A conforming Akko endpoint would most naturally add a dedicated WebSocket.

## Why it fits Akko

| AHP | Existing Akko choice | Assessment |
|---|---|---|
| Host-authoritative state | `SessionRuntime` is the single writer; clients never mutate canonical content | Direct match |
| Serialized client actions | Per-session attributed mailbox | Direct match; the mailbox is the policy/mutex AHP expects |
| Agent-agnostic host boundary | pi stays behind `WorkspaceRuntime` / `SessionRuntime` | Direct match |
| State snapshots are separate from agent liveness | Durable/liveness split; runtime is disposable | Direct match |
| Display-ready state | `Projector` is a sibling of canonical persistence | Direct match |
| Lazy URI subscriptions | Lazy `SessionRegistry`, cheap index/history reads | Direct match |
| Multi-client convergence | Multiplayer-shaped commands and shared Jazz projection | Same goal, different sync mechanism |
| Session/chat catalog | Conversations and subagents are first-class Akko sessions | Compatible, but requires an external mapping |
| Queued and steering messages | `prompt` / `followUp` / `steer` and mailbox state | Strong match |
| Tool/input state | pi events plus the extension-UI bridge planned in doc 08 | AHP supplies the missing public shape |
| Content references | Canonical entries plus future attachment/resource storage | Useful forward abstraction |
| Customizations/skills/MCP | `SkillsService`, agent types, pi extensions | A richer standardized UI model than Akko has today |
| Working directories/terminals/changesets | Distributed coding workspaces planned in doc 12 | Highly relevant to future IDE clients |

AHP's session/chat split is especially useful. An AHP session is a coordination scope and a
chat is an independently subscribable conversation. Akko currently uses one pi
`AgentSession` for both a top-level conversation and each child agent. Those internal
objects need not dictate the public shape: a parent conversation can be an AHP session,
its pi session can be the default AHP chat, and tool-spawned Akko subagent sessions can be
presented as worker chats with `origin.kind: "tool"`. This gives standard clients a fleet
view without forcing Akko to merge the underlying pi runtimes.

## What AHP does not replace

### Canonical conversation storage

AHP state is a reduced client presentation. Akko must still retain pi's full entries,
branch/compaction semantics, actor side-data, and whatever is needed to rehydrate a live
agent. `ConversationStore` remains canonical; AHP snapshots and actions are rebuildable
projections.

`serverSeq` is also not a replacement for Akko's future node replication cursor. AHP
sequences client-visible actions for reconnect/reconciliation. The node↔Hub entry channel
ships durable entries idempotently by `EntryId` across partitions. Those have different
failure and retention requirements.

### Identity, tenancy, and authorization

AHP's `clientId` identifies a connection for reconciliation; it is not an authenticated
Akko principal. Its protocol-level `authenticate` method delivers OAuth bearer tokens for
agent/MCP protected resources; authentication of the AHP endpoint itself is explicitly a
transport concern. AHP also does not model workspaces, memberships, roles, or durable human
authorship.

An Akko AHP connection must therefore:

- authenticate during the transport handshake;
- bind the connection to a `PrincipalId` and authorized workspace scope;
- filter `listSessions`, root notifications, subscriptions, and resources by membership;
- continue running every mutation through `RoleBasedPolicy` at the mailbox;
- retain `actorId` in canonical entries;
- optionally expose `actorId` in `Message._meta` for Akko-aware clients, while generic AHP
  clients ignore it.

AHP `activeClients` describes clients providing tools/customizations. It is not a complete
human presence or typing model. Jazz can continue to own first-party presence, drafts, and
typing when those are added.

### The first-party Jazz read path

Replacing Jazz with AHP in the browser would restore the machinery intentionally removed
in doc 15: a socket, subscriptions, reducer state, reconnect handling, and per-client event
folding. AHP's official clients make that machinery much less bespoke, but it would still
create a second first-party read model and give up Jazz's cross-tab/device replication.
There is no demonstrated benefit large enough to justify that rewrite now.

Jazz also cannot transparently carry AHP. It coalesces updates and exposes replicated table
state rather than a complete ordered JSON-RPC message stream. Akko may eventually derive
Jazz rows from AHP-shaped reduced state, but that is an internal projector choice, not an
AHP transport.

### The node↔Hub protocol

AHP is northbound: N user clients coordinating through a host. Akko's node link is
south/eastbound infrastructure: daemon enrollment, placement, command delivery, durable
write-ahead entry replication, cursor acknowledgements, and partition recovery. AHP lacks
those guarantees and concepts. Using it between Hub and SessionHost would hide rather than
remove the custom replication protocol.

Likewise, AHP does not require ACP below the host. Akko can continue embedding pi through
its SDK. ACP would only become relevant if Akko later hosts out-of-process ACP agents.

## Important impedance mismatches

1. **AHP action ingress versus Akko commands.** AHP clients dispatch optimistic state
   actions such as `chat/turnStarted`; Akko accepts imperative `Command`s. The adapter must
   validate/authorize, translate into a mailbox command, and echo an accepted or rejected
   AHP envelope. It must never bypass the mailbox.
2. **Ordering around side effects.** AHP requires `chat/turnStarted` to establish the
   active turn before deltas for that turn. Akko's `Mailbox.post()` currently resolves
   after pi preflight, by which point pi events may already be arriving. The adapter needs
   an ingress coordinator that either sequences acceptance before starting pi or buffers
   runtime events until the accepted action is emitted. Blindly translating EventBus
   callbacks can produce an invalid action order.
3. **Durable turn identity.** AHP uses stable turn, response-part, and tool-call ids.
   Akko's current durable store captures pi messages and actor ids but does not persist the
   command/turn id that initiated them. A faithful snapshot mapper needs stable ids and a
   durable association between an accepted AHP turn and the resulting pi entries.
4. **Session/chat topology.** The initial mapping can expose one default chat per
   conversation. Proper subagent support should later map child `SessionRef`s to worker
   chats in the parent's AHP session, not expose every child as an unrelated top-level AHP
   session.
5. **Current Jazz projection is intentionally lossy.** It flattens finalized text/tool
   calls and one in-flight activity row. AHP represents ordered response parts, complete
   tool lifecycle, reasoning, usage, elicitation, and pending messages. The AHP projector
   must map canonical entries and raw pi events directly, not reverse-engineer Jazz rows.
6. **No official TypeScript host library.** The package ships wire types, reducers,
   `AhpClient`, multi-host support, and WebSocket client transport. The listed reference
   server lives in VS Code. Akko must implement server-side JSON-RPC dispatch,
   subscriptions, sequencing, snapshots, and action buffering itself.
7. **Session disposal semantics.** AHP's `disposeSession` removes the session from the
   host catalogue and tears down its backend, while Akko has not yet decided its durable
   delete/tombstone policy. An adapter can eventually map disposal to a soft-deleted Akko
   session, but must not silently turn it into irreversible canonical deletion.
8. **Draft churn.** The protocol explicitly makes no backward-compatibility promise yet.
   AHP types must not leak into `@akko/core`, SQLite schemas, or pi-facing runtime APIs.

## Proposed Akko mapping

| Akko | AHP |
|---|---|
| Authenticated workspace view of the host | One workspace-scoped logical AHP host/root view |
| `SessionRef(kind="conversation")` | `ahp-session:/<id>` + one default chat initially |
| Top-level pi `AgentSession` | Default `ahp-chat:/<id>` |
| Child `SessionRef(kind="subagent")` | Later: worker chat in the parent's AHP session, with tool origin |
| `SessionIndex.list()` | `listSessions` / `SessionSummary` |
| `ConversationStore.getEntries()` | Rebuild `ChatState.turns` snapshot |
| pi streaming events | `chat/responsePart`, `chat/delta`, reasoning/tool/usage actions |
| `prompt` command | client `chat/turnStarted` action |
| `abort` command | client `chat/turnCancelled` action |
| `steer` / `followUp` | steering / queued pending-message actions |
| `rename` | `session/titleChanged` |
| `setModel` | model selection on message/session config, capability-gated |
| `actorId` | Canonical Akko side-data; optional `Message._meta["akko.actorId"]` |
| `Projector.rebuild()` | Snapshot reconstruction, independent of replay buffer |
| `EventBus` | Input to an AHP state/action projector, never the wire contract itself |

The exact URI mapping should be stable and persisted where it cannot be derived. AHP says
UUIDs are typical, not that Akko must discard its prefixed ids.

## Incremental implementation plan

### Phase 0 — isolated compatibility spike

Create an `@akko/ahp` package, pin `@microsoft/agent-host-protocol` to an exact version,
and add an authenticated `/ahp` WebSocket endpoint. Do not change the web app or
`@akko/core`.

Implement the smallest coherent host surface:

- `initialize`, `ping`, `subscribe`, `unsubscribe`, `listSessions`, and `reconnect`;
- root/session/chat snapshots;
- existing-session listing, `createSession`, and one default chat per conversation;
- an explicit soft-delete policy before advertising `disposeSession` support;
- `chat/turnStarted`, `chat/turnCancelled`, and `session/titleChanged` ingress through the
  mailbox;
- markdown streaming, turn completion/error, and basic tool-call actions;
- fresh-snapshot reconnect only (permitted by the spec) before adding a replay buffer;
- capability declarations that advertise only what is genuinely implemented.

Use the official `AhpClient` and reducers as black-box contract tests. The spike passes
only if it proves:

1. canonical history reconstructs a valid chat snapshot with stable ids;
2. two official clients converge during one live turn;
3. accepted/rejected optimistic actions reconcile correctly;
4. reconnect returns a converged snapshot without duplicate turns;
5. a viewer cannot mutate and a non-member cannot list/subscribe;
6. no AHP action can bypass Akko attribution, authorization, or mailbox ordering;
7. the existing HTTP+Jazz web path and tests remain unchanged.

### Phase 1 — useful external-client support

If the spike passes, add:

- a bounded in-memory `serverSeq` replay buffer (snapshot remains the fallback);
- queued/steering messages and mailbox feedback;
- full response-part/tool/input-request mapping;
- model and agent capability discovery;
- subagents as tool-origin worker chats;
- resource reads and content references needed by IDE clients.

Label the endpoint experimental while AHP remains pre-1.0.

### Phase 2 — coding-host features on demand

Terminals, resource watches, changesets, customizations/MCP, client-provided tools, and
telemetry are valuable but security-sensitive. Implement each only behind an explicit
capability and Akko authorization policy; do not claim broad conformance up front.

## Final assessment

AHP is likely the right **standard public abstraction** for exposing Akko sessions to
third-party clients. It captures more of the real agent UX than Akko's small private HTTP
protocol and would prevent us from inventing private wire shapes for tools, elicitation,
terminals, attachments, changesets, and reconnect.

It is not a reason to replace the architecture that already works. In fact, Akko's
mailbox, durable/liveness split, canonical/projected-state split, and projector seam are
what make AHP comparatively cheap to add. The prudent move is therefore:

> **Adopt AHP at the edge, preserve Akko at the core, and prove the adapter with an
> official-client compatibility spike before making it a promised interface.**
