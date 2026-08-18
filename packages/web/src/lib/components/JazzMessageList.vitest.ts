import { render, screen } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";

// The real QuerySubscription needs a live Jazz runtime; drive rendering from fixtures.
// Two queries now: `messages` (finalized) and `activity` (ephemeral live). The mock
// returns the right fixture based on which table the query object tags.
const { messageRows, activityRows } = vi.hoisted(() => ({
  messageRows: { current: [] as { id: string; role: string; text: string }[] },
  activityRows: { current: [] as { id: string; kind: string; text: string; toolLabel?: string; queuedCount?: number; queuedText?: string }[] },
}));

vi.mock("jazz-tools/svelte", () => ({
  QuerySubscription: class {
    #table: string;
    constructor(query: () => { __table: string }) {
      this.#table = query().__table;
    }
    get current() {
      return this.#table === "activity" ? activityRows.current : messageRows.current;
    }
    loading = false;
    error = null;
  },
}));
vi.mock("@akko/schema", () => {
  const q = (table: string) => ({ __table: table, orderBy: () => ({ __table: table }) });
  return {
    app: {
      messages: { where: () => q("messages") },
      activity: { where: () => q("activity") },
    },
  };
});

import JazzMessageList from "./JazzMessageList.svelte";

describe("JazzMessageList", () => {
  test("renders projected rows as role-tagged bubbles", () => {
    messageRows.current = [
      { id: "r1", role: "user", text: "hi" },
      { id: "r2", role: "assistant", text: "hello back" },
    ];
    activityRows.current = [];
    const { container } = render(JazzMessageList, { sessionId: "s1" });

    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.getByText("hello back")).toBeInTheDocument();
    expect(container.querySelector('[data-role="user"]')).not.toBeNull();
    expect(container.querySelector('[data-role="assistant"]')).not.toBeNull();
  });

  test("renders a tool row as a compact record rather than an empty bubble", () => {
    // The subagent regression: tools-only assistant messages have no text, so they used
    // to render as empty chat bubbles.
    messageRows.current = [
      { id: "r1", role: "tool", text: "spawn_subagent: Doc 01" },
    ];
    activityRows.current = [];
    const { container } = render(JazzMessageList, { sessionId: "s1" });

    expect(screen.getByText("spawn_subagent: Doc 01")).toBeInTheDocument();
    expect(container.querySelector("[data-tool]")).not.toBeNull();
  });

  test("keeps streamed text visible while a tool runs (no disappear/reappear flicker)", () => {
    // The turn says "I'll find the docs..." and then calls a tool. These are concurrent
    // live states, not alternatives — rendering them as alternatives made the sentence
    // vanish the moment the tool started and reappear once the message committed.
    messageRows.current = [];
    activityRows.current = [
      { id: "a1", kind: "tool", text: "I'll find the docs.", toolLabel: "spawn_subagent: 3 tasks" },
    ];
    render(JazzMessageList, { sessionId: "s1" });

    expect(screen.getByText("I'll find the docs.")).toBeInTheDocument();
    expect(screen.getByText("spawn_subagent: 3 tasks")).toBeInTheDocument();
  });

  test("shows work queued behind the current turn", () => {
    // Sending mid-turn is accepted and queued, not dropped; the UI has to say so or the
    // message looks lost until the turn ends.
    messageRows.current = [];
    activityRows.current = [
      { id: "a1", kind: "streaming", text: "working…", queuedCount: 2, queuedText: "do this next" },
    ];
    const { container } = render(JazzMessageList, { sessionId: "s1" });

    expect(container.querySelector("[data-queued]")).not.toBeNull();
    expect(screen.getByText(/do this next/)).toBeInTheDocument();
    expect(screen.getByText(/\+1 more/)).toBeInTheDocument();
  });

  test("no queue indicator when nothing is waiting", () => {
    messageRows.current = [];
    activityRows.current = [{ id: "a1", kind: "streaming", text: "working…", queuedCount: 0 }];
    const { container } = render(JazzMessageList, { sessionId: "s1" });
    expect(container.querySelector("[data-queued]")).toBeNull();
  });

  test("shows a live indicator while a tool is running", () => {
    // A blocking spawn_subagent can take minutes with no tokens; without this the UI
    // looks hung.
    messageRows.current = [];
    activityRows.current = [{ id: "a1", kind: "tool", text: "", toolLabel: "spawn_subagent: Docs audit" }];
    const { container } = render(JazzMessageList, { sessionId: "s1" });

    expect(screen.getByRole("status")).toHaveTextContent("spawn_subagent: Docs audit");
    expect(container.querySelector("[data-tool]")).not.toBeNull();
  });

  test("shows the empty state when there are no rows", () => {
    messageRows.current = [];
    activityRows.current = [];
    render(JazzMessageList, { sessionId: "s1" });
    expect(screen.getByText("No messages yet.")).toBeInTheDocument();
  });

  test("renders the live streaming bubble from the activity row", () => {
    messageRows.current = [{ id: "r1", role: "user", text: "hi" }];
    activityRows.current = [{ id: "act_s1", kind: "streaming", text: "partial answ" }];
    render(JazzMessageList, { sessionId: "s1" });
    expect(screen.getByText(/partial answ/)).toBeInTheDocument();
  });

  test("shows a thinking indicator from a thinking activity row", () => {
    messageRows.current = [{ id: "r1", role: "user", text: "hi" }];
    activityRows.current = [{ id: "act_s1", kind: "thinking", text: "" }];
    const { container } = render(JazzMessageList, { sessionId: "s1" });
    expect(container.querySelector("[data-thinking]")).not.toBeNull();
  });
});
