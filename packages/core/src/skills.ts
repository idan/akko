/**
 * Skills service (doc 06).
 *
 * Two goals: browse/manage skills, and make the system-prompt impact of installed
 * skills visible (exact injected content + token cost). Everything here is computed
 * against a workspace's `ResourceLoader` and pi's system-prompt introspection APIs,
 * so it reflects what pi actually loads rather than Akko's guess.
 */

import type { WorkspaceId } from "./domain.ts";

/** One discovered skill and its current state. */
export interface SkillInfo {
  name: string;
  description: string;
  /** Origin: user/global, project, or a package. */
  source: string;
  filePath: string;
  enabled: boolean;
  /** True when `disable-model-invocation` is set: hidden from the prompt, still `/skill:name`. */
  hiddenFromPrompt: boolean;
}

/** The prompt-budget view: what enabled skills cost right now (doc 06). */
export interface SkillImpact {
  /** Per-skill token cost of the always-in-context description block. */
  perSkill: Array<{ name: string; tokens: number; hiddenFromPrompt: boolean }>;
  /** Total tokens contributed by all enabled, prompt-visible skills. */
  totalTokens: number;
  /** The exact XML skills block injected into the system prompt. */
  injectedBlock: string;
}

export interface SkillsService {
  /** Inventory for a workspace (from `resourceLoader.getSkills()`). */
  list(workspaceId: WorkspaceId): Promise<SkillInfo[]>;

  /**
   * Compute the live prompt impact for a workspace: per-skill and total token cost,
   * plus the exact injected block. Uses pi's `estimateTokens` + system-prompt
   * introspection (doc 06).
   */
  impact(workspaceId: WorkspaceId): Promise<SkillImpact>;

  /** Enable/disable a skill, or toggle its `disable-model-invocation` flag. */
  setEnabled(
    workspaceId: WorkspaceId,
    name: string,
    state: { enabled?: boolean; hiddenFromPrompt?: boolean },
  ): Promise<void>;

  /**
   * Return the full assembled system prompt for a workspace (or a session), so the UI
   * can show everything currently in context, not just the skills block.
   */
  previewSystemPrompt(workspaceId: WorkspaceId): Promise<string>;
}
