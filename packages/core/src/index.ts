/**
 * @akko/core — domain model and interfaces for Akko, a personal agentic system built
 * on top of the pi coding agent.
 *
 * This is a design skeleton: types and interfaces only, with the reasoning documented
 * in `docs/architecture/`. It is single-user today and multiuser-by-construction.
 *
 * Module map:
 *   domain.ts             — Principal, Workspace, Membership, SessionRef, Command (ids + attribution)
 *   authz.ts              — authorize() choke point + concurrency policy
 *   workspace.ts          — WorkspaceRuntime: bind a Workspace to pi's per-call params
 *   conversation-store.ts — durable/canonical conversation persistence seam
 *   events.ts             — DomainEvent, EntrySink, EventBus (fan-out)
 *   projector.ts          — realtime read-model sink (e.g. Jazz), sibling of the store
 *   session-runtime.ts    — SessionRuntime + Mailbox (the actor / single writer)
 *   session-registry.ts   — lazy map of live runtimes; subagents as sessions; HostResolver
 *   router.ts             — string resolution + natural-language task routing
 *   memory.ts             — deferred memory seam (no-op default)
 *   skills.ts             — skill inventory + system-prompt impact
 *   sqlite.ts             — SqliteAdapter: the single runtime-coupled seam (bun:sqlite default)
 *   node.ts               — Node + Hub-side NodeDirectory + inference routing (distributed exec)
 *   replication.ts        — cursor-based append-only log shipping (node write-ahead ↔ Hub)
 *   node-link.ts          — node↔Hub wire protocol (control/command/entry/event channels)
 *   search.ts             — SearchIndex: retrieval seam (FTS5 now, vectors later)
 */

export * from "./domain.ts";
export * from "./authz.ts";
export * from "./workspace.ts";
export * from "./conversation-store.ts";
export * from "./events.ts";
export * from "./projector.ts";
export * from "./session-runtime.ts";
export * from "./session-registry.ts";
export * from "./router.ts";
export * from "./memory.ts";
export * from "./skills.ts";
export * from "./sqlite.ts";
export * from "./node.ts";
export * from "./replication.ts";
export * from "./node-link.ts";
export * from "./search.ts";
