import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AkkoClient } from "./client.svelte.ts";
import type { ServerMessage } from "@akko/protocol";

/** Minimal fake WebSocket: records sent frames and lets tests emit server messages. */
class FakeWebSocket {
  static last: FakeWebSocket | undefined;
  sent: string[] = [];
  #listeners: Record<string, ((e: any) => void)[]> = {};
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }
  addEventListener(type: string, cb: (e: any) => void) {
    (this.#listeners[type] ??= []).push(cb);
  }
  send(data: string) {
    this.sent.push(data);
  }
  emit(type: string, e: any) {
    for (const cb of this.#listeners[type] ?? []) cb(e);
  }
  server(msg: ServerMessage) {
    this.emit("message", { data: JSON.stringify(msg) });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeClient() {
  return new AkkoClient({ principalId: "prn_test", workspaceId: "wsp_test" });
}

describe("AkkoClient", () => {
  test("loadSessions populates sessions and remembers jazz ids", async () => {
    const client = makeClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        json: async () => ({ sessions: [{ id: "s1", title: "One", jazzId: "co_z1" }] }),
      })) as unknown as typeof fetch,
    );

    await client.loadSessions();

    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0]!.title).toBe("One");
    expect(client.jazzIds["s1"]).toBe("co_z1");
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions?workspaceId=wsp_test",
      expect.objectContaining({ headers: { "x-akko-principal": "prn_test" } }),
    );
  });

  test("createSession prepends the new session and makes it active", async () => {
    const client = makeClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => ({ ref: { id: "s9", title: "New" } }) })) as unknown as typeof fetch,
    );

    await client.createSession("New");

    expect(client.sessions[0]).toMatchObject({ id: "s9", title: "New" });
    expect(client.activeSessionId).toBe("s9");
    expect(client.activeConversation.messages).toEqual([]);
  });

  test("welcome flips connected and resubscribes to known sessions", async () => {
    const client = makeClient();
    client.select("s1");
    client.connect();
    const ws = FakeWebSocket.last!;
    ws.server({ t: "welcome" } as ServerMessage);

    expect(client.connected).toBe(true);
    // one subscribe queued at select() could not send (no socket yet); welcome resends.
    const subscribes = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "subscribe");
    expect(subscribes).toContainEqual({ t: "subscribe", sessionId: "s1" });
  });

  test("sendPrompt sets the awaiting (thinking) flag on the active conversation", async () => {
    const client = makeClient();
    client.select("s1");
    client.connect();
    FakeWebSocket.last!.server({ t: "welcome" } as ServerMessage);

    client.sendPrompt("hi");
    expect(client.activeConversation.awaiting).toBe(true);
  });

  test("select seeds canonical history once, only while the conversation is empty", async () => {
    const client = makeClient();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [
          { id: "h1", role: "user", content: "my name is Ada" },
          { id: "h2", role: "assistant", content: [{ type: "text", text: "Hi Ada" }] },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    client.connect();

    client.select("s1");
    await flush();
    expect(client.activeConversation.messages.map((m) => m.text)).toEqual(["my name is Ada", "Hi Ada"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/history", expect.anything());

    // Re-selecting does not refetch (history is loaded once per session).
    client.select("s1");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("history seeding does not clobber events that already streamed in", async () => {
    const client = makeClient();
    let resolveFetch: (v: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((r) => (resolveFetch = r))) as unknown as typeof fetch,
    );
    client.connect();
    client.select("s1");

    // A live event arrives before history resolves.
    FakeWebSocket.last!.server({
      t: "event",
      event: { type: "pi", sessionId: "s1", event: { type: "message_start", message: { role: "user", content: "live" } } },
    } as ServerMessage);

    resolveFetch({ ok: true, json: async () => ({ messages: [{ id: "h1", role: "user", content: "old" }] }) });
    await flush();

    // Live state wins; history is not applied over it.
    expect(client.activeConversation.messages.map((m) => m.text)).toEqual(["live"]);
  });

  test("an incoming pi event is folded into the session conversation", async () => {
    const client = makeClient();
    client.select("s1");
    client.connect();
    const ws = FakeWebSocket.last!;

    ws.server({
      t: "event",
      event: { type: "pi", sessionId: "s1", event: { type: "message_start", message: { role: "user", content: "hi" } } },
    } as ServerMessage);

    client.select("s1");
    expect(client.activeConversation.messages).toHaveLength(1);
    expect(client.activeConversation.messages[0]).toMatchObject({ role: "user", text: "hi" });
  });

  test("sendPrompt emits an attributed command frame", async () => {
    const client = makeClient();
    client.select("s1");
    client.connect();
    const ws = FakeWebSocket.last!;
    ws.server({ t: "welcome" } as ServerMessage);

    client.sendPrompt("  do it  ");

    const cmd = ws.sent.map((s) => JSON.parse(s)).find((m) => m.t === "command");
    expect(cmd).toMatchObject({ t: "command", sessionId: "s1", verb: "prompt", args: { text: "do it" } });
    await flush();
  });

  test("an error message surfaces on the store", async () => {
    const client = makeClient();
    client.connect();
    FakeWebSocket.last!.server({ t: "error", message: "nope" } as ServerMessage);
    expect(client.error).toBe("nope");
  });

  test("loadModels populates the model catalog", async () => {
    const client = makeClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ models: [{ provider: "anthropic", id: "claude-3-5-haiku", name: "Haiku" }] }),
      })) as unknown as typeof fetch,
    );
    await client.loadModels();
    expect(client.models).toHaveLength(1);
    expect(client.models[0]).toMatchObject({ provider: "anthropic", id: "claude-3-5-haiku" });
    expect(fetch).toHaveBeenCalledWith("/api/models?workspaceId=wsp_test", expect.anything());
  });

  test("setModel sends a command and optimistically updates the session", async () => {
    const client = makeClient();
    client.sessions = [{ id: "s1", title: "S" }] as typeof client.sessions;
    client.select("s1");
    client.connect();
    FakeWebSocket.last!.server({ t: "welcome" } as ServerMessage);

    client.setModel("s1", "anthropic/claude-3-5-haiku");

    const cmd = FakeWebSocket.last!.sent.map((s) => JSON.parse(s)).find((m) => m.verb === "setModel");
    expect(cmd).toMatchObject({ t: "command", sessionId: "s1", args: { model: "anthropic/claude-3-5-haiku" } });
    expect(client.sessions.find((s) => s.id === "s1")?.model).toBe("anthropic/claude-3-5-haiku");
  });

  test("a session patch event updates the model across tabs", async () => {
    const client = makeClient();
    client.sessions = [{ id: "s1", title: "S", model: "anthropic/opus" }] as typeof client.sessions;
    client.connect();
    FakeWebSocket.last!.server({
      t: "event",
      event: { type: "session", sessionId: "s1", patch: { model: "anthropic/haiku" } },
    } as unknown as ServerMessage);
    expect(client.sessions.find((s) => s.id === "s1")?.model).toBe("anthropic/haiku");
  });
});
