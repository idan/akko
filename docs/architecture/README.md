# Akko Architecture

Akko is an opinionated, minimalistic personal agentic system built **on top of the
[pi](https://pi.dev) coding agent**. It exposes agent sessions through a dedicated,
responsive web frontend (Svelte 5 + bits-ui), and is designed from day one to be
**multiuser / multiplayer capable** even though the first implementation may be
single-user.

These documents capture the design reasoning and the concrete decisions made while
scoping the system. They are meant to be read in order, but each stands alone.

## Index

| Doc | Topic |
|-----|-------|
| [00 — Vision and Goals](./00-vision-and-goals.md) | What we are building and the guiding principles |
| [01 — pi as Foundation](./01-pi-as-foundation.md) | What pi provides, which surfaces we build on, what it persists |
| [02 — Tenancy and Identity](./02-tenancy-and-identity.md) | The multiuser domain model; bake-in-now vs. seams |
| [03 — Runtime and Sessions](./03-runtime-and-sessions.md) | Durable/liveness split, the per-session mailbox, subagents |
| [04 — Storage and Persistence](./04-storage-and-persistence.md) | What pi stores vs. what we store; ConversationStore; SQLite + Jazz; single-writer |
| [05 — Model Routing](./05-model-routing.md) | String resolution vs. natural-language task routing |
| [06 — Skills and the System Prompt](./06-skills-and-system-prompt.md) | Browsing/managing skills; making prompt impact visible |
| [07 — Memory](./07-memory.md) | Why we punt now; the seam; learnings from existing systems |
| [08 — Frontend and Realtime](./08-frontend-and-realtime.md) | Svelte 5 + bits-ui, CQRS command/event flow, presence |
| [09 — Security and Isolation](./09-security-and-isolation.md) | pi has no sandbox; the isolation seam |
| [10 — Core Interfaces](./10-core-interfaces.md) | Overview of the `packages/core` TypeScript interfaces |
| [11 — Runtime Evaluation](./11-runtime-evaluation.md) | Bun vs. Deno, empirically tested against pi; why Bun is the default |
| [12 — Distributed Execution](./12-distributed-execution.md) | Remote daemons as execution points; Hub/SessionHost split; node↔Hub protocol; replication |
| [13 — Database Choice](./13-database-choice.md) | SQLite now; not the Turso engine; SearchIndex seam for future vector retrieval |
| [14 — Jazz Evaluation](./14-jazz-evaluation.md) | Bun-compat proven; Jazz as read/state projection (not source of truth); incremental adoption |
| [15 — Status and Roadmap](./15-status-and-roadmap.md) | **Resume here** — current state, test coverage, how to run, prioritized next steps |
| [16 — Authentication and Authorization](./16-auth.md) | Better Auth in-process (passkeys); cookie→principal at the edge; role-based `authorize()` |
| [17 — Agent Host Protocol Exploration](./17-ahp-evaluation.md) | Where AHP could help, where it conflicts, and questions to answer before any adoption decision |

## The one-paragraph summary

Akko runs a **long-lived backend process** that owns pi's SDK directly
(`createAgentSession`). Every conversation — and every subagent — is an
`AgentSession` held in a **SessionRegistry** and treated as a *disposable, live
cache* that can be rebuilt from durable storage. Commands from clients are
**attributed** and serialized through a **per-session mailbox** (the actor model),
which is where authorization and concurrency policy live. Canonical conversation
content is persisted through a **ConversationStore** seam; everything else
(identity, ACL, attribution, indexes, memory) lives in our own database. Clients
never write authoritative state — they send commands and render a projected,
realtime view. This shape is multiuser-by-construction: identity is on every record and
command from day one, and authentication (passkeys, doc 16) and the workspace read-ACL
are wired end-to-end.
