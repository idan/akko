import { render, screen } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";

// The real QuerySubscription needs a live Jazz runtime; drive rendering from fixtures.
// Two queries now: `messages` (finalized) and `activity` (ephemeral live). The mock
// returns the right fixture based on which table the query object tags.
const { messageRows, activityRows } = vi.hoisted(() => ({
  messageRows: { current: [] as { id: string; role: string; text: string }[] },
  activityRows: { current: [] as { id: string; kind: string; text: string }[] },
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
    expect(container.querySelector(".msg.user")).not.toBeNull();
    expect(container.querySelector(".msg.assistant")).not.toBeNull();
    expect(screen.getByText(/Projected read model/)).toBeInTheDocument();
  });

  test("shows the empty state when there are no rows", () => {
    messageRows.current = [];
    activityRows.current = [];
    render(JazzMessageList, { sessionId: "s1" });
    expect(screen.getByText("No projected messages yet.")).toBeInTheDocument();
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
    expect(container.querySelector(".bubble.thinking")).not.toBeNull();
  });
});
