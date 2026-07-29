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
    const active = container.querySelector('[aria-current="true"]');
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

describe("SessionList renaming", () => {
  const sessions = [{ id: "s1", title: "One" }, { id: "s2", title: "Two" }];

  test("the rename control opens an editor seeded with the current title", async () => {
    const user = userEvent.setup();
    const onrename = vi.fn();
    render(SessionList, { sessions, onselect: vi.fn(), oncreate: vi.fn(), onrename });

    await user.click(screen.getByRole("button", { name: "Rename One" }));

    const input = screen.getByRole("textbox", { name: "Session title" }) as HTMLInputElement;
    expect(input.value).toBe("One");
  });

  test("Enter commits a trimmed title", async () => {
    const user = userEvent.setup();
    const onrename = vi.fn();
    render(SessionList, { sessions, onselect: vi.fn(), oncreate: vi.fn(), onrename });

    await user.click(screen.getByRole("button", { name: "Rename One" }));
    const input = screen.getByRole("textbox", { name: "Session title" });
    await user.clear(input);
    await user.type(input, "  Renamed  {Enter}");

    expect(onrename).toHaveBeenCalledWith("s1", "Renamed");
  });

  test("Escape cancels without renaming", async () => {
    const user = userEvent.setup();
    const onrename = vi.fn();
    render(SessionList, { sessions, onselect: vi.fn(), oncreate: vi.fn(), onrename });

    await user.click(screen.getByRole("button", { name: "Rename One" }));
    await user.type(screen.getByRole("textbox", { name: "Session title" }), "Nope{Escape}");

    expect(onrename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Session title" })).toBeNull();
  });

  test("an unchanged or emptied title does not spend a command", async () => {
    const user = userEvent.setup();
    const onrename = vi.fn();
    render(SessionList, { sessions, onselect: vi.fn(), oncreate: vi.fn(), onrename });

    await user.click(screen.getByRole("button", { name: "Rename One" }));
    await user.keyboard("{Enter}"); // unchanged
    expect(onrename).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Rename One" }));
    await user.clear(screen.getByRole("textbox", { name: "Session title" }));
    await user.keyboard("{Enter}"); // emptied
    expect(onrename).not.toHaveBeenCalled();
  });

  test("without an onrename handler the control is absent", () => {
    render(SessionList, { sessions, onselect: vi.fn(), oncreate: vi.fn() });
    expect(screen.queryByRole("button", { name: "Rename One" })).toBeNull();
  });
});
