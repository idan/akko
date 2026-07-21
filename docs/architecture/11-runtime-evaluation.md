# 11 — Runtime Evaluation: Bun vs. Deno

**Decision: Bun is the default runtime. Deno is a verified-viable fallback.**

Both runtimes were tested empirically against the actual installed pi packages and
the intended stack. This is not a "one works, one doesn't" situation — pi and the
full stack run on **both**. The choice is therefore about ergonomics and
forward-compatibility risk, not feasibility.

## Test environment

- Bun 1.3.14, Deno 2.9.3, Node 26.2.0 (macOS arm64)
- `@earendil-works/pi-coding-agent` 0.80.6 (+ `pi-ai`, `pi-agent-core`, `pi-tui`)

## What pi actually requires (dependency audit)

- `engines: { node: ">=22.19.0" }` — pi is **Node-first**.
- Direct use of **`undici`** (custom HTTP dispatcher / proxy support).
- **`jiti`** for runtime TypeScript loading of extensions.
- **`node:worker_threads`, `node:child_process`** (via `cross-spawn`), `node:crypto`,
  `node:fs`, `node:module`, etc.
- **Native `.node` addons exist only in `pi-tui`** (terminal key modifiers / Windows
  console mode) — used solely by the interactive TUI, which Akko does **not** use.
  The SDK path has no mandatory native addon.
- `@silvia-odwyer/photon-node` is **WASM** (cross-runtime).

These are exactly the APIs that historically break on non-Node runtimes, so each was
tested directly.

## Empirical results

| Capability | Bun | Deno | Node |
|-----------|:---:|:----:|:----:|
| Import pi SDK barrel (144 exports) | ✅ | ✅ | ✅ |
| Construct `AuthStorage` / `ModelRegistry` / `SessionManager.inMemory()` | ✅ | ✅ | ✅ |
| **`jiti` runtime `.ts` extension load** (`DefaultResourceLoader.reload`) | ✅ | ✅ | ✅ |
| **`child_process` bash** (`createLocalBashOperations().exec`) | ✅ | ✅ | ✅ |
| **`undici`** `Agent` / `ProxyAgent` construct | ✅ | ✅ | ✅ |
| SQLite + **FTS5** + `bm25()` via `bun:sqlite` | ✅ | — | — |
| SQLite + **FTS5** via `node:sqlite` | ❌ (not implemented) | ✅ | ✅ |

The headline finding: **`jiti` TypeScript extension loading — the path most likely to
fail on Deno — works on Deno.** Every deep path behaves identically on Bun and Deno.

## Stack components (non-pi)

| Component | Bun | Deno | Notes |
|-----------|-----|------|-------|
| **Svelte 5 + bits-ui** | ✅ | ✅ | Built with Vite; runtime-agnostic. bits-ui is pure Svelte. Not a differentiator. |
| **WebSocket gateway** (event fan-out, doc 08) | ✅ `Bun.serve` | ✅ `Deno.serve` upgrade | First-class on both; Node needs `ws`. |
| **SQLite (ConversationStore / search)** | ✅ `bun:sqlite` | ✅ `node:sqlite` | Different module per runtime — see below. |
| **Turso / libsql** (see `docs/fts5-vs-turso-fts.md`) | ✅ `@libsql/client` | ✅ `@libsql/client` | Cross-runtime client; independent of the choice. |
| **Jazz** (realtime projection, doc 04/08) | ⚠️ verify | ⚠️ verify | Could not fetch Jazz docs in this evaluation. **Not on the critical path** — it is the optional, recreatable projection layer, swappable behind `Projector`. Verify the server worker on the chosen runtime before adopting; if it only supports Node, run it as a separate Node process. |

## Why Bun is the default

1. **Best forward-compat with a Node-first foundation.** pi targets Node semantics and
   pulls Node-first deps (`undici`, `jiti`, `worker_threads`, `cross-spawn`, and native
   addons in adjacent packages). Bun's design goal is Node drop-in compatibility, so it
   tracks Node behavior. Deno's node-compat is excellent *today* but is a compatibility
   layer that can lag on new/edge Node APIs. For a fast-moving Node-first dependency,
   Bun is the lower-babysitting bet over time.
2. **`bun:sqlite` is a near-perfect fit** for the ConversationStore + memory FTS
   search + single-file portability goals (native, synchronous, FTS5 + `bm25()`, zero
   dependencies).
3. **One toolchain** for the minimalistic stack: install + run TS directly + test +
   bundle, plus first-class `Bun.serve` WebSockets for the gateway.
4. **Native addon tolerance.** Bun supports most N-API addons; Deno does not. This
   matters if any future dependency ships a native addon.

## Why Deno remains a real fallback

Everything tested works on Deno 2.9. Choose it only if a hard external requirement
appears, e.g.:

- Deploying to **Deno Deploy**.
- Wanting **`node:sqlite`** so DB code is shared verbatim with a separate Node process.
- Preferring Deno's permissions model. (Note: this adds little for Akko — the agent
  needs broad fs/net/exec anyway, and *real* isolation is an OS/container boundary,
  doc 09.)

## Keep the decision reversible

The runtime choice touches exactly one place in the architecture: the **SQLite driver
behind `ConversationStore`** (doc 04) differs (`bun:sqlite` vs `node:sqlite`). Because
that is already a seam, swapping runtimes later is a one-adapter change, not a
rearchitecture. Keep any SQLite access behind a tiny `SqliteAdapter` interface so the
`bun:sqlite`↔`node:sqlite` difference never leaks into the rest of `core`.

## Action items before locking in

1. **Verify Jazz** on Bun (server worker). If Node-only, isolate it as a separate
   process; it is optional and recreatable, so it does not block.
2. Keep SQLite access behind a `SqliteAdapter` (`bun:sqlite` impl first).
3. Confirm the SvelteKit adapter story (Node adapter under Bun is the safe default).
