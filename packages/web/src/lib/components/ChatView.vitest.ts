import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

// ChatView imports JazzMessageList, which pulls the Jazz runtime; stub it out.
vi.mock("jazz-tools/svelte", () => ({ QuerySubscription: class {
  current = [];
  loading = false;
  error = null;
  constructor(_q: unknown) {}
} }));
vi.mock("@akko/schema", () => ({
  app: { messages: { where: () => ({}) }, activity: { where: () => ({}) } },
}));

import ChatView from "./ChatView.svelte";
import type { AkkoClient } from "../client.svelte.ts";

function client(over: Partial<AkkoClient> = {}): AkkoClient {
  return {
    sessions: [],
    models: [],
    activeSessionId: null,
    error: null,
    sendPrompt: vi.fn(),
    setModel: vi.fn(),
    ...over,
  } as unknown as AkkoClient;
}

describe("ChatView", () => {
  test("shows a placeholder when no session is active", () => {
    render(ChatView, { client: client(), onmenu: vi.fn() });
    expect(screen.getByText(/Create or select a session/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("renders the active session title from the read-model row when given one", () => {
    render(ChatView, {
      client: client({ activeSessionId: "s1" }),
      session: { title: "Roadmap" },
      onmenu: vi.fn(),
    });
    expect(screen.getByRole("heading", { name: "Roadmap" })).toBeInTheDocument();
  });

  test("falls back to the client's session copy for the title", () => {
    render(ChatView, {
      client: client({
        sessions: [{ id: "s1", title: "From HTTP" }] as AkkoClient["sessions"],
        activeSessionId: "s1",
      }),
      onmenu: vi.fn(),
    });
    expect(screen.getByRole("heading", { name: "From HTTP" })).toBeInTheDocument();
  });

  test("the composer sends prompts through the client", async () => {
    const user = userEvent.setup();
    const c = client({ activeSessionId: "s1" });
    render(ChatView, { client: c, onmenu: vi.fn() });

    await user.type(screen.getByRole("textbox"), "ship it");
    await user.keyboard("{Enter}");
    expect(c.sendPrompt).toHaveBeenCalledWith("ship it");
  });

  test("the menu button invokes onmenu", async () => {
    const user = userEvent.setup();
    const onmenu = vi.fn();
    render(ChatView, { client: client({ activeSessionId: "s1" }), onmenu });

    await user.click(screen.getByRole("button", { name: "Toggle sessions" }));
    expect(onmenu).toHaveBeenCalledTimes(1);
  });

  test("surfaces a client error as an alert", () => {
    render(ChatView, { client: client({ error: "command rejected" }), onmenu: vi.fn() });
    expect(screen.getByRole("alert")).toHaveTextContent("command rejected");
  });

  test("the model picker reflects the session model and sets it on change", async () => {
    const user = userEvent.setup();
    const c = client({
      activeSessionId: "s1",
      sessions: [{ id: "s1", title: "S", model: "anthropic/claude-sonnet-4-5" }] as AkkoClient["sessions"],
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { provider: "anthropic", id: "claude-3-5-haiku", name: "Claude Haiku 3.5" },
      ] as AkkoClient["models"],
    });
    render(ChatView, { client: c, onmenu: vi.fn() });

    const select = screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
    expect(select.value).toBe("anthropic/claude-sonnet-4-5");

    await user.selectOptions(select, "anthropic/claude-3-5-haiku");
    expect(c.setModel).toHaveBeenCalledWith("s1", "anthropic/claude-3-5-haiku");
  });
});
