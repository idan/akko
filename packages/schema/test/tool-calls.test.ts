/**
 * Tool-call description (doc 03/14). Assistant messages that only call tools carry no
 * text, so without this they project as empty rows and render as empty chat bubbles —
 * which is what a run of subagents looked like.
 */
import { describe, expect, test } from "bun:test";
import { describeToolCall, textOfContent, toolCallsOfContent } from "../src/index.ts";

describe("describeToolCall", () => {
  test("prefers a title, then path/command/pattern/task", () => {
    expect(describeToolCall({ name: "spawn_subagent", arguments: { title: "Docs audit", task: "long..." } }))
      .toBe("spawn_subagent: Docs audit");
    expect(describeToolCall({ name: "read", arguments: { path: "src/x.ts" } })).toBe("read: src/x.ts");
    expect(describeToolCall({ name: "bash", arguments: { command: "ls -la" } })).toBe("bash: ls -la");
  });

  test("falls back to the bare tool name when nothing is informative", () => {
    expect(describeToolCall({ name: "compact" })).toBe("compact");
    expect(describeToolCall({ name: "compact", arguments: { depth: 3 } })).toBe("compact");
  });

  test("collapses whitespace and truncates long hints", () => {
    const long = describeToolCall({ name: "spawn_subagent", arguments: { task: "a".repeat(200) } });
    expect(long.length).toBeLessThan(100);
    expect(long.endsWith("…")).toBe(true);
    expect(describeToolCall({ name: "bash", arguments: { command: "echo  a\n\nb" } })).toBe("bash: echo a b");
  });
});

describe("describeToolCall for batch tools", () => {
  const call = (tasks: unknown[]) => describeToolCall({ name: "spawn_subagent", arguments: { tasks } });

  test("summarises a batch by count and the first few titles", () => {
    // Without this the label falls through to a bare "spawn_subagent", which tells the
    // reader nothing about what is running — and a batch is now the normal shape.
    expect(call([1, 2, 3, 4, 5].map((n) => ({ task: "t", title: `Doc ${n}` }))))
      .toBe("spawn_subagent: 5 tasks — Doc 1, Doc 2 +3 more");
    expect(call([{ task: "t", title: "A" }, { task: "t", title: "B" }]))
      .toBe("spawn_subagent: 2 tasks — A, B");
  });

  test("a single task reads as itself, not as a count", () => {
    expect(call([{ task: "t", title: "Doc 1" }])).toBe("spawn_subagent: Doc 1");
    expect(call([{ task: "t" }])).toBe("spawn_subagent: 1 task");
  });

  test("untitled batches fall back to the count alone", () => {
    expect(call([{ task: "a" }, { task: "b" }, { task: "c" }])).toBe("spawn_subagent: 3 tasks");
  });
});

describe("toolCallsOfContent", () => {
  const toolsOnly = [
    { type: "toolCall", name: "spawn_subagent", arguments: { title: "One" } },
    { type: "toolCall", name: "spawn_subagent", arguments: { title: "Two" } },
  ];

  test("describes every tool call, one per line", () => {
    expect(toolCallsOfContent(toolsOnly)).toBe("spawn_subagent: One\nspawn_subagent: Two");
  });

  test("is empty for text-only content, which is what keeps normal messages normal", () => {
    expect(toolCallsOfContent([{ type: "text", text: "hello" }])).toBe("");
    expect(toolCallsOfContent("plain string")).toBe("");
    expect(toolCallsOfContent(undefined)).toBe("");
  });

  test("a tools-only message has no text — the empty-bubble case", () => {
    expect(textOfContent(toolsOnly)).toBe("");
    expect(toolCallsOfContent(toolsOnly)).not.toBe("");
  });
});
