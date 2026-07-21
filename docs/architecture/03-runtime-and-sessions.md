# 03 — Runtime and Sessions

This document covers three tightly-related ideas: the **durable/liveness split**,
the **per-session mailbox**, and treating **subagents as ordinary sessions**.

## Durable vs. liveness

The `AgentSession` object living in the backend's RAM — with its streaming state and
event subscriptions — is **liveness**. It is ephemeral, bound to one process, and
should be **disposable**.

The **durable** state is the persisted conversation (via the `ConversationStore`,
doc 04) plus our DB (index / ACL / attribution / command log).

> **Principle:** never treat the in-memory session as the source of truth. Always be
> able to throw it away and rebuild it from storage.

Why it matters:

- **Crash / restart recovery** — reopen from durable state.
- **Horizontal scale** — a session can be hosted on any node; moving it is a
  rehydrate, not a rearchitecture.
- **Multiplayer** — a second client connecting just triggers *rehydrate + subscribe*.
- **Cold sessions cost nothing** — a live `AgentSession` is created lazily on first
  access and `dispose()`d when idle.

Concretely: `durable = ConversationStore + DB`; `liveness = AgentSession cached in a
SessionRegistry, created lazily, disposable`.

## The per-session mailbox (the actor model)

A live `AgentSession` can only do one thing at a time: one agent run; while running,
new input can only be **queued** (`steer` / `followUp`). The moment two humans — or a
human plus a finishing subagent — can touch one session, we need serialization.

So each live session is modeled as an **actor with a mailbox**:

- The **mailbox** is a single-consumer, in-order queue owned by that session's
  runtime.
- Every item is **attributed** — it carries the `actorId` of who sent it.
- The runtime drains the mailbox one item at a time and applies each via pi's API:
  `prompt` when idle, `steer` / `followUp` when busy.

You never touch the `AgentSession` directly. You **post an attributed command to its
mailbox.**

This single pattern gives us four things:

1. **Safety** — concurrent human input cannot corrupt session state (serialized).
2. **A policy point** — `authorize()` and concurrency policy (free-for-all,
   turn-lock, role-gated) run at the mailbox boundary.
3. **Fan-out** — one consumer, many observers; broadcasting events to N clients is
   trivial (doc 08).
4. **Scale-out routing** — "post to the mailbox that owns session X" is already how
   we'd route across nodes; today the owner is always local (`HostResolver`).

```
        clients ──post attributed commands──┐
                                            ▼
   ┌──────────────── Mailbox (in-order, single consumer) ───────────────┐
   │  { actorId, verb: "prompt", args }                                  │
   │  { actorId, verb: "steer",  args }                                  │
   └────────────────────────────┬───────────────────────────────────────┘
                                 ▼  drain one at a time
                     SessionRuntime (owns the AgentSession)
                                 │  prompt / steer / followUp / abort
                                 ▼
                            pi AgentSession
                                 │  events
                                 ▼
                     ConversationStore (durable) + Projector (realtime)
```

### Two policy decisions that fall out of the mailbox

1. **Attribution to the model** (doc 04): always store `actorId` on the entry as a
   side-field (cheap, reversible); *optionally* render `Alice:` into the visible
   message content only when more than one human participates.
2. **Concurrency policy**: default is **free-for-all with the attributed queue**
   (anyone with `editor` role can prompt/steer; steers apply in order), refined by
   role in `authorize()`. Alternatives (turn-lock, owner-only abort/setModel) are
   pure policy at the same boundary, so cheap to change — but the *default* shapes
   the UI, so it is decided now.

## The SessionRegistry

The registry is the map from `sessionId` to a live `SessionRuntime`, plus lazy
lifecycle:

- `get(sessionId)` — return the live runtime, creating (rehydrating) it on demand.
- Creation resolves the owning workspace, builds the pi parameter bundle
  (`WorkspaceRuntime`), calls `createAgentSession`, binds extensions, subscribes,
  and wires the durable + projection sinks.
- Idle sessions are `dispose()`d to reclaim memory; durable state remains.
- `HostResolver` decides *which node* owns a session (constant today).

## Subagents are sessions

A subagent is spawned in-process via `createAgentSession` with its own `model`,
`tools`, and system prompt, and is **registered in the same SessionRegistry** as a
`SessionRef` with `kind: "subagent"` and a `parentSessionId`. Consequences:

- The web UI can render live subagents (a web "FleetView") for free — they're just
  more sessions on the event bus.
- ACL inherits from the parent session/workspace.
- The parent session's tool that spawns a subagent posts to the child's mailbox and
  later reads its result — same primitives, no special path.

We take the **agent-type `.md` convention** (frontmatter: model, thinkingLevel,
tools, systemPromptMode, inheritSkills, defaultContext) as inspiration from
`@tintinweb/pi-subagents` and `pi-subagents`, but implement our own thin
`spawnSubagent()` so we carry none of their terminal-only UI (doc 08 explains why
their FleetView/widgets don't fit a web backend). See doc 08 for the reuse analysis.
