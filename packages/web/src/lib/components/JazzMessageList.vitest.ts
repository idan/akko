import { render, screen } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";

// The real QuerySubscription needs a live Jazz runtime; drive rendering from a fixture.
const { rows } = vi.hoisted(() => ({ rows: { current: [] as { id: string; role: string; text: string }[] } }));

vi.mock("jazz-tools/svelte", () => ({
  QuerySubscription: class {
    get current() {
      return rows.current;
    }
    loading = false;
    error = null;
    constructor(_query: unknown) {}
  },
}));
vi.mock("@akko/schema", () => ({ app: { messages: { where: () => ({}) } } }));

import JazzMessageList from "./JazzMessageList.svelte";

describe("JazzMessageList", () => {
  test("renders projected rows as role-tagged bubbles", () => {
    rows.current = [
      { id: "r1", role: "user", text: "hi" },
      { id: "r2", role: "assistant", text: "hello back" },
    ];
    const { container } = render(JazzMessageList, { sessionId: "s1" });

    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.getByText("hello back")).toBeInTheDocument();
    expect(container.querySelector(".msg.user")).not.toBeNull();
    expect(container.querySelector(".msg.assistant")).not.toBeNull();
    expect(screen.getByText(/Projected read model/)).toBeInTheDocument();
  });

  test("shows the empty state when there are no rows", () => {
    rows.current = [];
    render(JazzMessageList, { sessionId: "s1" });
    expect(screen.getByText("No projected messages yet.")).toBeInTheDocument();
  });
});
