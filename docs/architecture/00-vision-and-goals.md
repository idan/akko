# 00 — Vision and Goals

## What Akko is

A **personal agentic system** — comparable in spirit to OpenClaw or Hermes Agent —
that uses **pi as the underlying agent harness** and adds an opinionated layer on
top of it. Akko is deliberately small and focused rather than a
gateway-for-everything.

## Goals

1. **Use pi as the agent harness.** We do not reimplement the agent loop, tool
   execution, provider plumbing, session tree, or compaction. pi already does this
   well and exposes it through a typed SDK.

2. **A dedicated web frontend.** A single, first-party UI built with **Svelte 5**
   and **bits-ui**. It must be **responsive and usable on mobile**. We are *not*
   supporting Telegram, Discord, Slack, or a plugin marketplace of gateways.

3. **Multiple sessions.** The system manages many concurrent agent sessions, not a
   single conversation. Subagents are just more sessions (see doc 03).

4. **A memory system.** Persistent memory for the agent. We may adopt an existing
   provider or build our own — see doc 07. This is explicitly allowed to be
   deferred.

5. **Skill browsing and management**, plus **clarity about the impact of installed
   skills on the system prompt** — token cost and the exact injected content. See
   doc 06.

6. **Natural-language model routing.** The system can take a task and route it to an
   appropriate model. See doc 05.

## Guiding principles

- **Minimal and opinionated.** Prefer one good way over many configurable ways.
  Fewer moving parts, clearer invariants.

- **Build our own where the fit matters; borrow patterns where it doesn't.** We are
  unafraid to implement our own layer rather than adopt a package that imposes an
  architecture that fights our design. But we freely take inspiration and patterns
  from existing pi packages (`@tintinweb/pi-subagents`, `pi-subagents`,
  `pi-hermes-memory`).

- **Design for multiuser now, implement it later.** Multiuser/multiplayer has deep,
  cross-cutting downstream impact (identity, attribution, isolation, storage,
  routing). We bake the *structural* invariants in from the first commit and hide
  the rest behind seams (see doc 02). We must avoid a future rearchitecture.

- **pi via its parameters, not its internals.** pi's `createAgentSession()` accepts
  `cwd`, `authStorage`, `modelRegistry`, `sessionManager`, `settingsManager`, and
  `resourceLoader` as **per-call parameters**. Tenancy is achieved by *what we pass
  in per session*, not by patching pi. This is the load-bearing fact that makes the
  whole design possible without forking.

## Non-goals (for now)

- Multiple chat gateways / integrations.
- A public extension marketplace.
- Running arbitrary untrusted third-party code without an isolation boundary
  (we design the seam; we don't promise the sandbox yet — see doc 09).
- A finished memory implementation (deferred; seam only — see doc 07).
