/**
 * Workspace-owned config in SQLite (doc 04/06): agent types and skills travel with the
 * database rather than living on one machine's disk.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceId } from "@akko/core";
import { BunSqliteAdapter } from "../src/sqlite-bun.ts";
import { SqliteWorkspaceConfigStore } from "../src/workspace-config-store.ts";
import { materializeSkills, skillsVersion, toSkillMarkdown, withWorkspaceSkills } from "../src/merged-resource-loader.ts";

const root = mkdtempSync(join(tmpdir(), "akko-cfg-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const WS = "wsp_1" as WorkspaceId;
const OTHER = "wsp_2" as WorkspaceId;

function store(name: string) {
  return new SqliteWorkspaceConfigStore(new BunSqliteAdapter(join(root, `${name}.db`)));
}

describe("skills in SQLite", () => {
  test("round-trips and is scoped per workspace", () => {
    const s = store("skills");
    s.upsertSkill({ workspaceId: WS, name: "alpha", description: "does alpha", content: "# Alpha", hiddenFromPrompt: false });
    s.upsertSkill({ workspaceId: OTHER, name: "beta", description: "does beta", content: "# Beta", hiddenFromPrompt: false });

    const mine = s.listSkills(WS);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: "alpha", description: "does alpha", hiddenFromPrompt: false });
    expect(s.listSkills(OTHER).map((x) => x.name)).toEqual(["beta"]);
  });

  test("upsert updates in place rather than duplicating", () => {
    const s = store("skills-upsert");
    s.upsertSkill({ workspaceId: WS, name: "a", description: "v1", content: "one", hiddenFromPrompt: false });
    s.upsertSkill({ workspaceId: WS, name: "a", description: "v2", content: "two", hiddenFromPrompt: false });
    expect(s.listSkills(WS)).toHaveLength(1);
    expect(s.listSkills(WS)[0]).toMatchObject({ description: "v2", content: "two" });
  });

  test("prompt visibility toggles without touching any user file", () => {
    // This is the whole reason skills moved into the database: the alternative was
    // rewriting `disable-model-invocation` into the user's own SKILL.md.
    const s = store("skills-toggle");
    s.upsertSkill({ workspaceId: WS, name: "a", description: "d", content: "c", hiddenFromPrompt: false });

    expect(s.setSkillHidden(WS, "a", true)).toBe(true);
    expect(s.listSkills(WS)[0]!.hiddenFromPrompt).toBe(true);
    expect(s.setSkillHidden(WS, "missing", true)).toBe(false);
    // A workspace cannot toggle another's skill.
    expect(s.setSkillHidden(OTHER, "a", true)).toBe(false);
  });

  test("delete removes only the addressed skill", () => {
    const s = store("skills-delete");
    s.upsertSkill({ workspaceId: WS, name: "a", description: "d", content: "c", hiddenFromPrompt: false });
    s.upsertSkill({ workspaceId: WS, name: "b", description: "d", content: "c", hiddenFromPrompt: false });
    expect(s.deleteSkill(WS, "a")).toBe(true);
    expect(s.listSkills(WS).map((x) => x.name)).toEqual(["b"]);
    expect(s.deleteSkill(WS, "a")).toBe(false);
  });
});

describe("agent types in SQLite", () => {
  test("round-trips including the tool allowlist", () => {
    const s = store("agents");
    s.upsertAgentType({
      workspaceId: WS,
      name: "researcher",
      description: "Reads only",
      model: "anthropic/claude-3-5-haiku",
      thinkingLevel: "low",
      tools: ["read", "grep"],
      instructions: "You only read.",
    });
    expect(s.listAgentTypes(WS)[0]).toMatchObject({
      name: "researcher",
      model: "anthropic/claude-3-5-haiku",
      thinkingLevel: "low",
      tools: ["read", "grep"],
      instructions: "You only read.",
    });
  });

  test("tools are stored as JSON, so a comma in a name cannot corrupt the list", () => {
    const s = store("agents-json");
    s.upsertAgentType({ workspaceId: WS, name: "x", tools: ["a,b", "c"], instructions: "i" });
    expect(s.listAgentTypes(WS)[0]!.tools).toEqual(["a,b", "c"]);
  });

  test("an empty allowlist is stored as absent, meaning pi's defaults", () => {
    const s = store("agents-empty");
    s.upsertAgentType({ workspaceId: WS, name: "x", tools: [], instructions: "i" });
    expect(s.listAgentTypes(WS)[0]!.tools).toBeUndefined();
  });
});

describe("materializeSkills", () => {
  const skill = (name: string, hidden = false) => ({
    workspaceId: WS,
    name,
    description: "d",
    content: "# Body",
    hiddenFromPrompt: hidden,
    updatedAt: 1,
  });

  test("writes SKILL.md files pi can actually read", () => {
    const dir = join(root, "mat1");
    const out = materializeSkills(dir, [skill("alpha")]);

    expect(out).toHaveLength(1);
    expect(existsSync(out[0]!.filePath)).toBe(true);
    const written = readFileSync(out[0]!.filePath, "utf8");
    expect(written).toContain("name: alpha");
    expect(written).toContain("# Body");
    expect(out[0]!.sourceInfo.source).toBe("workspace");
  });

  test("hidden skills carry disable-model-invocation into the frontmatter", () => {
    expect(toSkillMarkdown(skill("q", true))).toContain("disable-model-invocation: true");
    expect(toSkillMarkdown(skill("q", false))).not.toContain("disable-model-invocation");
  });

  test("re-materializing clears removed skills, so disk matches the database", () => {
    // A stale file would keep being discovered by pi after the row was deleted.
    const dir = join(root, "mat2");
    const first = materializeSkills(dir, [skill("alpha"), skill("beta")]);
    expect(existsSync(first[1]!.filePath)).toBe(true);

    materializeSkills(dir, [skill("alpha")]);
    expect(existsSync(first[0]!.filePath)).toBe(true);
    expect(existsSync(first[1]!.filePath)).toBe(false);
  });

  test("names that could escape the directory are refused, not written", () => {
    // Skill names arrive from the API/UI, so they are untrusted input to a filesystem
    // write. A traversal-shaped name is dropped rather than sanitized into something
    // surprising.
    const dir = join(root, "mat3");
    expect(materializeSkills(dir, [skill("../escape")])).toHaveLength(0);
    expect(materializeSkills(dir, [skill(".hidden")])).toHaveLength(0);
  });

  test("ordinary names with odd characters are sanitized and stay contained", () => {
    const dir = join(root, "mat4");
    const out = materializeSkills(dir, [skill("my skill/v2")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath.startsWith(dir)).toBe(true);
    expect(out[0]!.name).toBe("my skill/v2"); // the advertised name is unchanged
  });
});

describe("withWorkspaceSkills", () => {
  const base = {
    getSkills: () => ({ skills: [{ name: "fromDisk" }], diagnostics: ["d1"] }),
    getPrompts: () => ({ prompts: ["p"] }),
  };

  test("merges DB skills into pi's discovery and preserves diagnostics", () => {
    const merged = withWorkspaceSkills(base as unknown as typeof base & { getSkills: () => { skills: unknown[]; diagnostics: unknown[] } }, () => [{ name: "fromDb" } as never]);
    const result = merged.getSkills();
    expect((result.skills as Array<{ name: string }>).map((s) => s.name)).toEqual(["fromDisk", "fromDb"]);
    expect(result.diagnostics).toEqual(["d1"]);
  });

  test("a file skill wins over a database skill of the same name", () => {
    // What you can see and edit should not be silently shadowed by a row.
    const merged = withWorkspaceSkills(base as unknown as typeof base & { getSkills: () => { skills: unknown[]; diagnostics: unknown[] } }, () => [{ name: "fromDisk" } as never]);
    expect(merged.getSkills().skills).toHaveLength(1);
  });

  test("every other loader method delegates untouched", () => {
    const merged = withWorkspaceSkills(base as never, () => []);
    expect((merged as unknown as typeof base).getPrompts()).toEqual({ prompts: ["p"] });
  });
});

describe("materialization is incremental", () => {
  const skill = (name: string, content = "# Body") => ({
    workspaceId: WS, name, description: "d", content, hiddenFromPrompt: false, updatedAt: 1,
  });

  test("an unchanged skill's file is left completely alone", () => {
    // A blanket clear-and-rewrite makes every unchanged file briefly absent; a session
    // reading one at that moment gets ENOENT for something that never changed.
    const dir = join(root, "inc1");
    const [a] = materializeSkills(dir, [skill("alpha"), skill("beta")]);
    const before = statSync(a!.filePath).mtimeMs;

    materializeSkills(dir, [skill("alpha"), skill("beta", "# Changed")]);
    expect(statSync(a!.filePath).mtimeMs).toBe(before); // untouched
  });

  test("changed content is rewritten, and removed rows are deleted", () => {
    const dir = join(root, "inc2");
    const out = materializeSkills(dir, [skill("alpha"), skill("beta")]);
    materializeSkills(dir, [skill("alpha", "# New")]);

    expect(readFileSync(out[0]!.filePath, "utf8")).toContain("# New");
    expect(existsSync(out[1]!.filePath)).toBe(false); // stale row's file removed
  });
});

describe("skillsVersion", () => {
  const s = (name: string, content: string, hidden = false) => ({
    workspaceId: WS, name, description: "d", content, hiddenFromPrompt: hidden, updatedAt: 1,
  });

  test("is stable across ordering but changes with content, name or visibility", () => {
    const base = [s("a", "one"), s("b", "two")];
    expect(skillsVersion(base)).toBe(skillsVersion([base[1]!, base[0]!])); // order-independent
    expect(skillsVersion(base)).not.toBe(skillsVersion([s("a", "one"), s("b", "CHANGED")]));
    expect(skillsVersion(base)).not.toBe(skillsVersion([s("a", "one"), s("renamed", "two")]));
    // Visibility matters: it changes what reaches the prompt.
    expect(skillsVersion(base)).not.toBe(skillsVersion([s("a", "one", true), s("b", "two")]));
  });

  test("empty is stable", () => {
    expect(skillsVersion([])).toBe(skillsVersion([]));
  });
});
