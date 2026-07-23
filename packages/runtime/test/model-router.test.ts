import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AkkoModelRouter, modelRef } from "../src/model-router.ts";

/**
 * String-resolution slice of the ModelRouter (doc 05). Uses a real `ModelRuntime` built
 * from the agent dir; assertions that need actual models are guarded on availability so
 * the suite stays green in environments without configured auth.
 */
const router = new AkkoModelRouter();
let runtime: ModelRuntime;

beforeAll(async () => {
  const agentDir = getAgentDir();
  runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
}, 30_000);

describe("AkkoModelRouter (string resolution, slice 1)", () => {
  test("modelRef builds a canonical provider/id reference", () => {
    expect(modelRef({ provider: "anthropic", id: "claude-3-5-haiku" })).toBe("anthropic/claude-3-5-haiku");
  });

  test("catalog entries carry capability + cost fields", async () => {
    const catalog = await router.catalog(runtime);
    expect(Array.isArray(catalog)).toBe(true);
    for (const e of catalog) {
      expect(typeof e.provider).toBe("string");
      expect(typeof e.id).toBe("string");
      expect(typeof e.contextWindow).toBe("number");
      expect(e.cost).toHaveProperty("input");
      expect(e.cost).toHaveProperty("output");
    }
  }, 30_000);

  test("resolveModelString round-trips a known model; nonsense returns an error string", async () => {
    const catalog = await router.catalog(runtime);
    if (catalog.length === 0) return; // no authed models here — skip the resolution assertions
    const first = catalog[0]!;
    const resolved = router.resolveModelString(`${first.provider}/${first.id}`, runtime);
    expect(typeof resolved).not.toBe("string");
    if (typeof resolved !== "string") expect(resolved.id).toBe(first.id);

    const miss = router.resolveModelString("definitely-not-a-real-model-xyz", runtime);
    expect(typeof miss).toBe("string");
  }, 30_000);

  test("routeTask is deferred to slice 2", async () => {
    await expect(router.routeTask({ task: "summarize" }, runtime)).rejects.toThrow("slice 2");
  });
});
