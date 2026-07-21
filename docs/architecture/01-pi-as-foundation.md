# 01 — pi as Foundation

This document records what pi provides, which surfaces Akko builds on, and — most
importantly — **what pi actually persists**. All of it was verified against the
installed `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, and
`@earendil-works/pi-ai` packages and their docs.

## Integration surfaces pi exposes

| Layer | What it's for | Akko's use |
|-------|---------------|------------|
| **SDK** (`createAgentSession`, `AgentSessionRuntime`) | Embed pi in a Node process with typed control over model, tools, prompts, sessions | **Primary.** Our backend owns the loop in-process. |
| **Extensions** (`.ts` modules) | Hook lifecycle events, register tools/commands, gate tool calls, inject context | Used per-session (memory hook, guards). Note: **session-scoped**. |
| **RPC mode** (`pi --mode rpc`) | JSON-RPC over stdin/stdout subprocess | Fallback for process isolation later; not primary. |
| **Run modes** (`InteractiveMode`, `runPrintMode`, `runRpcMode`) | Reuse pi's built-in loops | Not used; we build our own frontend. |
| **Packages / skills / prompts / providers** | Distributable, composable capabilities | Skills (doc 06), custom providers (doc 05). |

### Why SDK in-process, not RPC-subprocess-per-session

- Type safety and direct access to `session.messages` / agent state.
- A **shared** `AuthStorage` / `ModelRegistry` across all sessions in a workspace.
- Subagents are trivially just more in-process `AgentSession`s (doc 03/08).

RPC-subprocess is only preferable when we need crash containment or process-level
isolation. We keep it as a later option behind the runtime seam; the
`AgentMessage`/event types are identical either way, so a session can migrate to a
subprocess without touching the rest of the system.

## The load-bearing fact: per-call parameterization

`createAgentSession(options)` takes, **per call**:

- `cwd` — working directory (also used to build cwd-bound tools)
- `authStorage: AuthStorage` — credentials (defaults to `~/.pi/agent/auth.json`,
  but constructible at a custom path)
- `modelRegistry: ModelRegistry` — models + availability (custom `models.json` path)
- `sessionManager: SessionManager` — conversation persistence
- `settingsManager: SettingsManager` — merged settings
- `resourceLoader: ResourceLoader` — extensions, skills, prompts, themes, context
- `tools` / `customTools` / `excludeTools`, `model`, `thinkingLevel`, etc.

None of these are process globals. **Tenancy = a per-workspace bundle of these
parameters** (doc 02). This is why Akko needs no pi fork.

## Events and control (the `AgentSession` API we drive)

- `prompt(text, opts)`, `steer(text)`, `followUp(text)`, `abort()`
- `setModel(model)`, `setThinkingLevel(level)`, `cycleModel()`
- `subscribe(listener) => unsubscribe` — streaming text/thinking/tool events,
  turn/agent/message lifecycle, queue/compaction/retry events
- `messages`, `isStreaming`, `agent.state`, `agent.waitForIdle()`
- `compact()`, `navigateTree()`, `dispose()`
- Session **replacement** (`newSession`, `switchSession`, `fork`, `importFromJsonl`)
  lives on `AgentSessionRuntime`, not `AgentSession`. After replacement, the
  `AgentSession` object changes and subscriptions/extension bindings must be
  re-attached.

The event stream is what we fan out to web clients (doc 08).

## What pi persists (critical for storage design)

pi's `SessionManager` persists exactly **one thing: the session entry tree** — an
append-only tree of entries linked by `id` / `parentId`:

- **messages**: user / assistant / toolResult / bashExecution
- **context-affecting metadata**: model changes, thinking-level changes, compaction
  summaries, branch summaries
- **labels**, **session name** (`session_info`), and extension **`custom`** entries

That tree is the minimum needed to (a) rebuild the LLM context via
`buildSessionContext()` and (b) support branch / fork / compaction.

pi persists **nothing** about identity, ownership, ACL, presence, memory, routing,
or message authorship. Those are entirely Akko's concern (doc 02, doc 04).

### Persistence modes and the pluggability seam

Verified layering:

| Level | API | Storage options |
|-------|-----|-----------------|
| `pi-coding-agent` SDK | `SessionManager` (private ctor) | `create(cwd)` → JSONL file, or `inMemory()` → RAM only. **No custom-storage injection point.** |
| `pi-agent-core` | `SessionStorage<T>` / `SessionRepo<T>` interfaces | JSONL (`JsonlSessionStorage`/`JsonlSessionRepo`) and in-memory (`InMemorySessionRepo`) impls provided. **A real seam** (`appendEntry`, `getEntry`, `getEntries`, `getPathToRoot`, leaf tracking, `createEntryId`). |
| below that | `FileSystem` abstraction | pluggable filesystem |

Implication for Akko: a SQLite-backed conversation store is achievable at three
levels of commitment, and our own `ConversationStore` seam (doc 04) hides which one
we choose:

1. **JSONL-canonical** — use `SessionManager.create`; JSONL is pi's durable store,
   our DB indexes it. **Not used** — see the writer finding below.
2. **DB-canonical via mirror** — `SessionManager.inMemory()` + capture entries into
   SQLite; rehydrate by replay. **Implemented** (`@akko/runtime`
   `SqliteConversationStore`).
3. **DB-canonical via `SessionStorage`** — implement `pi-agent-core`'s
   `SessionStorage` over SQLite and drop below `createAgentSession` to the Agent
   harness. Cleanest single-store; deferred.

> **Verified (pi 0.80.10):** pi's `SessionManager` file writer is deferred, exposes no
> public `flush()`, and only persists as part of pi's own runtime lifecycle — a bare
> manager never wrote to disk even after ~2s. Akko therefore owns persistence rather
> than depending on pi's writer. See doc 04 for the full rationale.

## Types we depend on (real export locations)

- From `@earendil-works/pi-coding-agent`: `createAgentSession`,
  `AgentSession`, `AgentSessionEvent`, `AgentSessionRuntime`, `SessionManager`,
  `SettingsManager`, `AuthStorage`, `ModelRegistry`, `DefaultResourceLoader`,
  `ResourceLoader`, `defineTool`, `PromptOptions`, `Skill`, `PromptTemplate`.
- From `@earendil-works/pi-ai`: `Model`, `ThinkingLevel`, `ImageContent`,
  `TextContent`, `Usage`.
- From `@earendil-works/pi-agent-core`: `AgentMessage`, and the session storage
  abstractions (`SessionStorage`, `SessionRepo`, `Session`, `SessionTreeEntry`,
  `SessionMetadata`).
