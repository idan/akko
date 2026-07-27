import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import SessionList from "./SessionList.svelte";

describe("SessionList", () => {
  test("lists sessions and marks the active one", () => {
    const { container } = render(SessionList, {
      sessions: [
        { id: "s1", title: "First" },
        { id: "s2", title: "Second" },
      ],
      activeId: "s2",
      onselect: vi.fn(),
      oncreate: vi.fn(),
    });

    expect(screen.getByText("First")).toBeInTheDocument();
    const active = container.querySelector(".session.active");
    expect(active?.textContent?.trim()).toBe("Second");
  });

  test("shows an empty state and offline status by default", () => {
    render(SessionList, { sessions: [], onselect: vi.fn(), oncreate: vi.fn() });
    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(screen.getByText("○ offline")).toBeInTheDocument();
  });

  test("reflects a connected status", () => {
    render(SessionList, { sessions: [], connected: true, onselect: vi.fn(), oncreate: vi.fn() });
    expect(screen.getByText("● connected")).toBeInTheDocument();
  });

  test("fires oncreate and onselect callbacks", async () => {
    const user = userEvent.setup();
    const onselect = vi.fn();
    const oncreate = vi.fn();
    render(SessionList, { sessions: [{ id: "s1", title: "First" }], onselect, oncreate });

    await user.click(screen.getByRole("button", { name: "New" }));
    expect(oncreate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText("First"));
    expect(onselect).toHaveBeenCalledWith("s1");
  });
});
