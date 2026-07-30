/**
 * AkkoSkillsService (doc 06) — inventory and prompt-budget visibility for pi skills.
 *
 * Every enabled skill's name + description sits in the system prompt on **every turn**
 * (progressive disclosure: the full SKILL.md is only read on demand). That standing cost
 * is invisible in normal use, and it is what this service exposes.
 *
 * Everything is computed with pi's own `formatSkillsForPrompt` and `estimateTokens`, so
 * the block shown is byte-identical to what pi injects rather than a reconstruction that
 * can drift.
 */
import { estimateTokens, formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

/**
 * Token estimate for a prompt fragment. pi's `estimateTokens` takes a message, so the
 * fragment is wrapped as one — using pi's estimator rather than our own arithmetic keeps
 * these numbers consistent with the ones pi reports elsewhere (e.g. compaction).
 */
const tokensOf = (text: string): number =>
  text ? estimateTokens({ role: "user", content: [{ type: "text", text }] } as never) : 0;
import type { SkillImpact, SkillInfo, WorkspaceId } from "@akko/core";
import type { WorkspaceRuntime } from "@akko/core";

export interface SkillsServiceDeps {
  /** Resolve a workspace's runtime bundle (resource loader, cwd, model runtime). */
  workspaceRuntime: (workspaceId: WorkspaceId) => Promise<WorkspaceRuntime>;
  /**
   * Build a throwaway pi session for prompt preview. Injected so the service doesn't
   * depend on the registry, and so tests can avoid constructing a real agent.
   */
  buildPreviewSession?: (wr: WorkspaceRuntime) => Promise<{ systemPrompt: string }>;
}

/** Map a pi `Skill` to the shape the UI consumes. */
function toInfo(skill: Skill): SkillInfo {
  return {
    name: skill.name,
    description: skill.description,
    source: skill.sourceInfo?.source ?? skill.sourceInfo?.scope ?? "unknown",
    filePath: skill.filePath,
    // Discovery *is* enablement in pi: a discovered skill is loaded. The meaningful
    // distinction is whether it reaches the prompt (see `hiddenFromPrompt`).
    enabled: true,
    hiddenFromPrompt: skill.disableModelInvocation === true,
  };
}

export class AkkoSkillsService {
  readonly #deps: SkillsServiceDeps;

  constructor(deps: SkillsServiceDeps) {
    this.#deps = deps;
  }

  async list(workspaceId: WorkspaceId): Promise<SkillInfo[]> {
    const skills = await this.#skills(workspaceId);
    return skills.map(toInfo).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Live prompt budget for a workspace.
   *
   * Per-skill cost is measured by **difference** — the block with every skill minus the
   * block without this one — rather than by tokenizing an entry in isolation. That is
   * both exact (it uses pi's formatter, never a copy of its layout) and the number a
   * reader actually wants: "what would I save by removing this?". It also attributes the
   * block's fixed preamble to the last remaining skill, which is correct: removing it
   * removes the whole section.
   */
  async impact(workspaceId: WorkspaceId): Promise<SkillImpact> {
    const skills = await this.#skills(workspaceId);
    const injectedBlock = formatSkillsForPrompt(skills);
    const totalTokens = tokensOf(injectedBlock);

    const perSkill = skills.map((skill) => {
      const without = skills.filter((s) => s !== skill);
      const withoutBlock = formatSkillsForPrompt(without);
      const withoutTokens = tokensOf(withoutBlock);
      return {
        name: skill.name,
        // Hidden skills contribute nothing, so this naturally reports 0 for them.
        tokens: Math.max(0, totalTokens - withoutTokens),
        hiddenFromPrompt: skill.disableModelInvocation === true,
      };
    });

    return { perSkill, totalTokens, injectedBlock };
  }

  /**
   * The full assembled system prompt, so the UI can show everything in context rather
   * than only the skills block. Built from a real pi session: reconstructing the prompt
   * ourselves would drift from what pi actually sends, which defeats the purpose.
   */
  async previewSystemPrompt(workspaceId: WorkspaceId): Promise<string> {
    const wr = await this.#deps.workspaceRuntime(workspaceId);
    if (!this.#deps.buildPreviewSession) return "";
    const session = await this.#deps.buildPreviewSession(wr);
    return session.systemPrompt;
  }

  async #skills(workspaceId: WorkspaceId): Promise<Skill[]> {
    const wr = await this.#deps.workspaceRuntime(workspaceId);
    const loader = (wr as { resourceLoader?: { getSkills(): { skills: Skill[] } } }).resourceLoader;
    // A workspace with no loader (or no skills) is normal, not an error.
    return loader?.getSkills().skills ?? [];
  }
}
