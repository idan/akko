# 06 — Skills and the System Prompt

Two goals: **browse/manage skills**, and give **clarity about the impact of installed
skills on the system prompt** (both the exact injected content and its token cost).
pi exposes exactly the hooks needed; this is a genuine value-add with low risk.

## How pi skills work (the relevant mechanics)

- Skills are discovered from several locations (global `~/.pi/agent/skills`,
  `~/.agents/skills`; project `.pi/skills`, `.agents/skills`; packages; settings;
  CLI). The `ResourceLoader` performs discovery.
- **Progressive disclosure:** only each skill's **name + description** is *always*
  in the system prompt (as an XML block per the Agent Skills spec). The full
  `SKILL.md` is loaded on demand via `read` or `/skill:name`.
- `disable-model-invocation: true` in frontmatter **hides a skill from the system
  prompt** entirely (still callable via `/skill:name`).
- The always-in-context descriptions are the **budget line** users care about: every
  enabled skill costs tokens on every turn.

## What Akko can show (and how)

| Feature | pi API |
|---------|--------|
| **List all skills** (name, description, source, path) | `resourceLoader.getSkills()` |
| **Exact injected block** for a session | `ctx.getSystemPrompt()` (full assembled prompt) inside `before_agent_start`, or `ctx.getSystemPromptOptions().skills` for the structured set |
| **Per-skill token cost** | tokenize each skill's contributed description block (pi exports `estimateTokens`); sum for a live "skill budget" |
| **Toggle a skill** | settings (`pi config` semantics) or `disable-model-invocation` frontmatter |
| **Loaded set at turn time** | `before_agent_start` event → `event.systemPromptOptions.skills` |

The `before_agent_start` event and `ExtensionCommandContext.getSystemPromptOptions()`
expose the same structured inputs pi uses to build the prompt (custom prompt, active
tools, tool snippets, guidelines, appended system prompt text, cwd, context files,
skills). This is how we render an accurate, *live* view rather than re-parsing
config ourselves.

## The Skills UI concept

A workspace-scoped **Skills manager** in the web frontend:

1. **Inventory** — every discovered skill with source (user / project / package),
   description, and current enabled/disabled state.
2. **Prompt budget** — a running total of tokens contributed by enabled skills, and
   a per-skill breakdown, updated live as the user toggles.
3. **Prompt preview** — the exact skill XML block that will be injected, plus (on
   demand) the full assembled system prompt so the user can see everything in
   context.
4. **Toggles** — enable/disable, or set `disable-model-invocation` to keep a skill
   available on demand without paying the always-on description cost.

## Multiuser note

Skill configuration is **per-workspace** (it's part of the `WorkspaceRuntime`
resource bundle, doc 02). The prompt-impact view is therefore computed against the
session's workspace registry/loader, so different workspaces can have different
enabled skill sets and budgets.

## Status — built

The **Skills panel** (`packages/web/src/lib/components/SkillsPanel.svelte`, reachable from
the sidebar) implements the UI concept above: inventory with source badges, the per-turn
budget as the headline number, per-skill cost, a visibility toggle, the injected block, and
the full assembled prompt on demand. Skills are **ordered by cost**, because the budget
view exists to find what to trim. Building the full prompt spins up a session, so it is
only fetched when opened — never on render.

## Backend (slice 1: visibility)

`AkkoSkillsService` (`packages/runtime/src/skills-service.ts`) implements `list`,
`impact` and `previewSystemPrompt`, exposed at **`GET /api/skills?workspaceId=`**.

- **Inventory** comes from `resourceLoader.getSkills()`, so it reflects pi's real
  discovery (global, project, package) rather than our own scan.
- **The injected block** is produced by pi's own `formatSkillsForPrompt`, so it is
  byte-identical to what pi sends — not a reconstruction that can drift.
- **Per-skill cost is measured by difference**: the block with every skill minus the block
  without this one. That uses pi's formatter rather than a copy of its layout, and it is
  the number a reader actually wants — *what would I save by removing this?* It also
  charges the block's fixed preamble to the last remaining skill, which is right: removing
  it removes the whole section. Hidden (`disable-model-invocation`) skills report 0.
- **Token counts use pi's `estimateTokens`**, so they agree with the numbers pi reports
  elsewhere (e.g. compaction) rather than being a second opinion.

Measured on a workspace with a single small skill: **163 tokens on every turn**.

### Workspace-owned skills live in SQLite

Skills (and agent types, doc 03) can be stored as **rows in canonical SQLite** rather than
files on one machine's disk, so a workspace's whole configuration travels in the database
file. This matters beyond convenience: a session may be rehydrated on any node (doc 12),
and config living on a developer's filesystem does not travel with it.

pi still reads skill *bodies* from disk — progressive disclosure advertises a
`<location>` the model then `read`s, and `/skill:name` does a plain `readFileSync`. So
workspace skills are **materialized** into `<cwd>/.akko/skills/` before use and merged
into pi's discovery by wrapping its `ResourceLoader`. SQLite is canonical; those files are
a disposable projection rebuilt from it, exactly as the Jazz read model is (doc 04).
Re-materializing clears the directory first, so a deleted row cannot leave a stale skill
behind.

#### When materialization runs, and how staleness is detected

There is no watcher and no explicit trigger: skills are synced whenever a **workspace
runtime is resolved** — creating a session, rehydrating a cold one, spawning a subagent,
building a prompt preview, or hitting the skills API. Live sessions short-circuit
`registry.get()`, so an ordinary command does *not* re-sync.

Two properties make that safe:

- **The sync is incremental.** Files are written only when their content differs, and only
  directories without a matching row are removed. An earlier version cleared the directory
  and rewrote everything, which made every *unchanged* skill briefly absent — a session
  reading one at that moment would get `ENOENT` for a file nothing had asked to change.
- **Sessions carry a version stamp.** A session's system prompt is a **snapshot**: pi
  assembles the skills block once, at build time. Changing skills therefore does *not*
  update a running session, and a deleted skill leaves it advertising a path that no
  longer exists. That is inherent — but it must not be silent, so each live session
  records the skills hash it was built from and `registry.staleSkillSessions(workspaceId)`
  reports the divergence. `GET /api/skills` returns it as `staleSessions`, and the server
  logs a warning. Evicting a session (or letting it go cold) is the remedy: it rebuilds
  from current config on next use.

Disk discovery is untouched, and **on a name collision the file wins**: a project skill
committed to a repo should stay git-diffable and editable, and should not be silently
shadowed by a row. The inventory reports `source` (`workspace` vs pi's own), so the origin
stays legible.

**This is what makes toggling possible.** `setHiddenFromPrompt` flips
`disable-model-invocation` for workspace-owned skills — a column update, not a rewrite of
someone's files. Disk skills return `false` rather than being edited behind the user's
back, which is the honest boundary: we manage what we own.

Skills may also live wherever pi already discovers them, e.g.
`~/.akko/workspaces/<id>/tree/.pi/skills/`.

## Interfaces

See `packages/core/src/skills.ts` and doc 10: `SkillInfo`, `SkillImpact`,
`SkillsService` (`list`, `impact`, `setEnabled`, `previewSystemPrompt`).
