/**
 * SkillsService (doc 06): inventory + the standing system-prompt cost of skills.
 *
 * The numbers come from pi's own `formatSkillsForPrompt`/`estimateTokens`, so these tests
 * pin the *semantics* (what counts, what doesn't, how removal is priced) rather than
 * asserting magic token counts that would break whenever pi retunes its estimator.
 */
import { describe, expect, test } from "bun:test";
import type { WorkspaceId } from "@akko/core";
import { AkkoSkillsService } from "../src/skills-service.ts";

const WS = "wsp_1" as WorkspaceId;

/** A pi-shaped skill; only the fields the service reads. */
function skill(name: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    name,
    description: `does ${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { path: `/skills/${name}`, source: "project", scope: "project", origin: "dir" },
    disableModelInvocation: false,
    ...over,
  };
}

function service(skills: unknown[], preview?: string) {
  return new AkkoSkillsService({
    workspaceRuntime: async () =>
      ({ resourceLoader: { getSkills: () => ({ skills, diagnostics: [] }) } }) as never,
    buildPreviewSession: preview === undefined ? undefined : async () => ({ systemPrompt: preview }),
  });
}

describe("list", () => {
  test("maps discovered skills, sorted by name", async () => {
    const s = service([skill("zebra"), skill("alpha")]);
    const list = await s.list(WS);
    expect(list.map((x) => x.name)).toEqual(["alpha", "zebra"]);
    expect(list[0]).toMatchObject({
      description: "does alpha",
      source: "project",
      filePath: "/skills/alpha/SKILL.md",
      enabled: true,
      hiddenFromPrompt: false,
    });
  });

  test("marks disable-model-invocation skills as hidden from the prompt", async () => {
    const s = service([skill("quiet", { disableModelInvocation: true })]);
    expect((await s.list(WS))[0]).toMatchObject({ hiddenFromPrompt: true, enabled: true });
  });

  test("a workspace with no loader or no skills is empty, not an error", async () => {
    expect(await service([]).list(WS)).toEqual([]);
    const noLoader = new AkkoSkillsService({ workspaceRuntime: async () => ({}) as never });
    expect(await noLoader.list(WS)).toEqual([]);
  });
});

describe("impact", () => {
  test("reports the exact block pi injects, and a positive total", async () => {
    const s = service([skill("alpha"), skill("beta")]);
    const impact = await s.impact(WS);

    // Byte-identical to pi's own formatter — this is the point of using it.
    expect(impact.injectedBlock).toContain("<available_skills>");
    expect(impact.injectedBlock).toContain("<name>alpha</name>");
    expect(impact.injectedBlock).toContain("<description>does beta</description>");
    expect(impact.totalTokens).toBeGreaterThan(0);
  });

  test("per-skill cost is what removing that skill would save", async () => {
    const s = service([skill("alpha"), skill("beta")]);
    const impact = await s.impact(WS);

    expect(impact.perSkill.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
    for (const p of impact.perSkill) expect(p.tokens).toBeGreaterThan(0);
    // Each is only its own entry, so neither can account for the whole block.
    for (const p of impact.perSkill) expect(p.tokens).toBeLessThan(impact.totalTokens);
  });

  test("the last remaining skill is charged the whole block, since removing it removes the section", async () => {
    const s = service([skill("only")]);
    const impact = await s.impact(WS);
    expect(impact.perSkill[0]!.tokens).toBe(impact.totalTokens);
  });

  test("hidden skills cost nothing and are excluded from the block", async () => {
    const s = service([skill("visible"), skill("quiet", { disableModelInvocation: true })]);
    const impact = await s.impact(WS);

    expect(impact.injectedBlock).not.toContain("quiet");
    const quiet = impact.perSkill.find((p) => p.name === "quiet");
    expect(quiet).toMatchObject({ tokens: 0, hiddenFromPrompt: true });
  });

  test("no skills means no block and no cost", async () => {
    const impact = await service([]).impact(WS);
    expect(impact).toMatchObject({ injectedBlock: "", totalTokens: 0, perSkill: [] });
  });
});

describe("setHiddenFromPrompt", () => {
  test("toggles a workspace-owned skill", async () => {
    const calls: Array<[string, string, boolean]> = [];
    const s = new AkkoSkillsService({
      workspaceRuntime: async () => ({}) as never,
      config: {
        listSkills: () => [{ name: "owned" }],
        setSkillHidden: (w, n, h) => {
          calls.push([w, n, h]);
          return true;
        },
      },
    });
    expect(await s.setHiddenFromPrompt(WS, "owned", true)).toBe(true);
    expect(calls).toEqual([[WS, "owned", true]]);
  });

  test("refuses skills that came from disk rather than rewriting the user's files", async () => {
    const s = new AkkoSkillsService({
      workspaceRuntime: async () => ({}) as never,
      config: { listSkills: () => [], setSkillHidden: () => false },
    });
    expect(await s.setHiddenFromPrompt(WS, "fromDisk", true)).toBe(false);
  });

  test("is a no-op when no workspace store is wired", async () => {
    expect(await service([]).setHiddenFromPrompt(WS, "x", true)).toBe(false);
  });
});

describe("previewSystemPrompt", () => {
  test("returns the assembled prompt from a real session", async () => {
    const s = service([skill("alpha")], "SYSTEM PROMPT HERE");
    expect(await s.previewSystemPrompt(WS)).toBe("SYSTEM PROMPT HERE");
  });

  test("is empty when no preview builder is wired, rather than throwing", async () => {
    expect(await service([skill("alpha")]).previewSystemPrompt(WS)).toBe("");
  });
});
