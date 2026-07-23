import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import SessionList from "./SessionList.svelte";
import type { AkkoClient } from "../client.svelte.ts";

/** SessionList only reads a few fields off the client, so a plain stub is enough. */
function clientStub(over: Partial<AkkoClient> = {}): AkkoClient {
  return {
    sessions: [],
    activeSessionId: null,
    connected: false,
    ...over,
  } as unknown as AkkoClient;
}

describe("SessionList", () => {
  test("lists sessions and marks the active one", () => {
    const { container } = render(SessionList, {
      client: clientStub({
        sessions: [
          { id: "s1", title: "First" },
          { id: "s2", title: "Second" },
        ] as AkkoClient["sessions"],
        activeSessionId: "s2",
      }),
      onselect: vi.fn(),
      oncreate: vi.fn(),
    });

    expect(screen.getByText("First")).toBeInTheDocument();
    const active = container.querySelector(".session.active");
    expect(active?.textContent?.trim()).toBe("Second");
  });

  test("shows an empty state and offline status by default", () => {
    render(SessionList, { client: clientStub(), onselect: vi.fn(), oncreate: vi.fn() });
    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(screen.getByText("○ offline")).toBeInTheDocument();
  });

  test("reflects a connected status", () => {
    render(SessionList, { client: clientStub({ connected: true }), onselect: vi.fn(), oncreate: vi.fn() });
    expect(screen.getByText("● connected")).toBeInTheDocument();
  });

  test("fires oncreate and onselect callbacks", async () => {
    const user = userEvent.setup();
    const onselect = vi.fn();
    const oncreate = vi.fn();
    render(SessionList, {
      client: clientStub({ sessions: [{ id: "s1", title: "First" }] as AkkoClient["sessions"] }),
      onselect,
      oncreate,
    });

    await user.click(screen.getByRole("button", { name: "New" }));
    expect(oncreate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText("First"));
    expect(onselect).toHaveBeenCalledWith("s1");
  });
});
