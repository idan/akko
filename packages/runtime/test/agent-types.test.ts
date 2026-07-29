/**
 * Agent types (doc 03): named subagent presets from `.md` frontmatter.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAgentType,
  describeAgentTypes,
  loadAgentTypes,
  parseAgentType,
} from "../src/agent-types.ts";

describe("parseAgentType", () => {
  test("reads configuration from frontmatter and instructions from the body", () => {
    const t = parseAgentType(
      "researcher",
      [
        "---",
        "description: Read-only research",
        "model: anthropic/claude-3-5-haiku",
        "thinkingLevel: low",
        "tools: [read, grep, find]",
        "---",
        "You are a research subagent.",
      ].join("\n"),
    );
    expect(t).toMatchObject({
      name: "researcher",
      description: "Read-only research",
      model: "anthropic/claude-3-5-haiku",
      thinkingLevel: "low",
      tools: ["read", "grep", "find"],
      instructions: "You are a research subagent.",
    });
  });

  test("accepts a comma-separated tools string as well as an array", () => {
    const t = parseAgentType("r", "---\ntools: read, grep\n---\nHi");
    expect(t?.tools).toEqual(["read", "grep"]);
  });

  test("a body with no frontmatter is still a valid type", () => {
    const t = parseAgentType("plain", "Just be terse.");
    expect(t?.instructions).toBe("Just be terse.");
    expect(t?.model).toBeUndefined();
  });

  test("a file with neither instructions nor config is rejected, not silently inert", () => {
    expect(parseAgentType("empty", "")).toBeUndefined();
    expect(parseAgentType("empty", "---\nunknownKey: 1\n---\n   ")).toBeUndefined();
  });
});

describe("loadAgentTypes", () => {
  test("loads .md files, ignores everything else, and tolerates a missing directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "akko-agents-"));
    writeFileSync(join(dir, "researcher.md"), "---\ndescription: R\n---\nResearch.");
    writeFileSync(join(dir, "reviewer.md"), "Review carefully.");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    mkdirSync(join(dir, "nested"));

    const types = loadAgentTypes(dir);
    expect([...types.keys()].sort()).toEqual(["researcher", "reviewer"]);
    expect(types.get("researcher")?.description).toBe("R");

    // Most workspaces define none; that must not be an error.
    expect(loadAgentTypes(join(dir, "does-not-exist")).size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("applyAgentType", () => {
  test("prepends instructions to the task", () => {
    const t = parseAgentType("r", "Be terse.");
    expect(applyAgentType(t, "Summarize x.md")).toBe("Be terse.\n\n---\n\nTask:\nSummarize x.md");
  });

  test("passes the task through untouched when there is no type", () => {
    expect(applyAgentType(undefined, "Summarize x.md")).toBe("Summarize x.md");
  });
});

describe("describeAgentTypes", () => {
  test("summarises available types for the tool description", () => {
    const types = new Map([
      ["researcher", { name: "researcher", description: "Reads only", instructions: "x" }],
      ["reviewer", { name: "reviewer", instructions: "y" }],
    ]);
    expect(describeAgentTypes(types)).toBe("researcher (Reads only); reviewer");
    expect(describeAgentTypes(new Map())).toBe("");
  });
});
