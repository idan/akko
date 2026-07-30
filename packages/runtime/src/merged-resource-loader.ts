/**
 * MergedResourceLoader — adds workspace-owned skills (SQLite) to pi's disk discovery.
 *
 * pi's progressive disclosure advertises each skill's `<location>` in the system prompt so
 * the model can `read` the body on demand, and `/skill:name` does a plain
 * `readFileSync(skill.filePath)`. A skill that existed only as a database row would
 * therefore list correctly and then fail the moment anything opened it.
 *
 * So DB skills are **materialized** into the workspace tree before use: SQLite stays
 * canonical, the files are a disposable projection rebuilt from it (doc 04 — the same
 * discipline as the Jazz read model). Wiping the directory loses nothing.
 *
 * Disk discovery is untouched. Project skills committed to a repo should stay files, and
 * on a name collision the file wins — the thing in front of you in your editor should not
 * be silently overridden by a database row.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceId } from "@akko/core";
import type { StoredSkill } from "./workspace-config-store.ts";

/** The pi `Skill` shape we synthesize (structurally compatible with pi's own). */
export interface MaterializedSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  sourceInfo: { path: string; source: string; scope: string; origin: string };
  disableModelInvocation: boolean;
}

/** Serialize a stored skill back to SKILL.md form, including the frontmatter pi parses. */
export function toSkillMarkdown(skill: StoredSkill): string {
  const fm = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description.replace(/\n/g, " ")}`,
    ...(skill.hiddenFromPrompt ? ["disable-model-invocation: true"] : []),
    "---",
    "",
  ].join("\n");
  return `${fm}${skill.content}\n`;
}

/**
 * Write workspace skills into `<dir>/<name>/SKILL.md` and return them in pi's shape.
 *
 * The directory is cleared first so a deleted or renamed skill cannot linger on disk and
 * keep being discovered — the projection must match the canonical rows exactly.
 */
export function materializeSkills(dir: string, skills: StoredSkill[]): MaterializedSkill[] {
  rmSync(dir, { recursive: true, force: true });
  if (skills.length === 0) return [];
  mkdirSync(dir, { recursive: true });

  const out: MaterializedSkill[] = [];
  for (const skill of skills) {
    // Names come from the UI/API, so keep them to a safe path segment rather than
    // trusting them into a filesystem write.
    const safe = skill.name.replace(/[^a-zA-Z0-9._-]/g, "-");
    if (!safe || safe.startsWith(".")) continue;
    const baseDir = join(dir, safe);
    const filePath = join(baseDir, "SKILL.md");
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(filePath, toSkillMarkdown(skill), "utf8");
    out.push({
      name: skill.name,
      description: skill.description,
      filePath,
      baseDir,
      sourceInfo: { path: filePath, source: "workspace", scope: "workspace", origin: "db" },
      disableModelInvocation: skill.hiddenFromPrompt,
    });
  }
  return out;
}

/** Minimal shape of the loader we wrap (pi's `ResourceLoader`). */
type LoaderLike = {
  getSkills(): { skills: unknown[]; diagnostics: unknown[] };
  [key: string]: unknown;
};

/**
 * Wrap a pi `ResourceLoader` so `getSkills()` also returns workspace-owned skills.
 *
 * Everything else delegates untouched: extensions, prompts, themes, agents files and
 * reload all keep pi's behaviour, so this cannot drift from whatever pi adds later.
 */
export function withWorkspaceSkills<T extends LoaderLike>(
  loader: T,
  getWorkspaceSkills: () => MaterializedSkill[],
): T {
  return new Proxy(loader, {
    get(target, prop, receiver) {
      if (prop !== "getSkills") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return () => {
        const base = target.getSkills();
        const names = new Set(
          (base.skills as Array<{ name?: string }>).map((s) => s?.name).filter(Boolean),
        );
        // File wins on collision: what you can see and edit should not be shadowed.
        const extra = getWorkspaceSkills().filter((s) => !names.has(s.name));
        return { skills: [...base.skills, ...extra], diagnostics: base.diagnostics };
      };
    },
  });
}

/** Where a workspace's DB skills are materialized. */
export const workspaceSkillsDir = (cwd: string, _workspaceId: WorkspaceId): string =>
  join(cwd, ".akko", "skills");
