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

## Interfaces

See `packages/core/src/skills.ts` and doc 10: `SkillInfo`, `SkillImpact`,
`SkillsService` (`list`, `impact`, `setEnabled`, `previewSystemPrompt`).
