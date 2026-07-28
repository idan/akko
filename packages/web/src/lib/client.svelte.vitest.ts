/**
 * AkkoClient is write-only now (doc 15, unify step 3): HTTP for sessions and commands,
 * with every read coming from the Jazz read model. So these tests are about the *command*
 * contract — URL, method, credentials, and how a rejection differs from a failure.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { AkkoClient } from "./client.svelte.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const makeClient = () => new AkkoClient({ principalId: "prn_test", workspaceId: "wsp_test" });

/** Stub `fetch` with a JSON body and status. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

describe("AkkoClient", () => {
  test("loadSessions populates the session list", async () => {
    const client = makeClient();
    stubFetch({ sessions: [{ id: "s1", title: "One" }] });

    await client.loadSessions();

    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0]!.title).toBe("One");
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions?workspaceId=wsp_test",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("createSession prepends the new session and makes it active", async () => {
    const client = makeClient();
    stubFetch({ ref: { id: "s9", title: "New" } });

    await client.createSession("New");

    expect(client.sessions[0]).toMatchObject({ id: "s9", title: "New" });
    expect(client.activeSessionId).toBe("s9");
  });

  test("loadModels populates the picker, and a failed request is a no-op", async () => {
    const client = makeClient();
    stubFetch({ models: [{ id: "m", provider: "p", name: "M" }] });
    await client.loadModels();
    expect(client.models).toHaveLength(1);

    stubFetch({}, false, 500);
    await client.loadModels();
    expect(client.models).toHaveLength(1); // unchanged
  });

  test("sendPrompt POSTs an attributed command to the session's command endpoint", async () => {
    const client = makeClient();
    const fn = stubFetch({ result: { accepted: true } });
    client.select("s1");

    client.sendPrompt("  hello  ");
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());

    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sessions/s1/commands");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include"); // identity is the cookie, never the body
    expect(JSON.parse(String(init.body))).toEqual({ verb: "prompt", args: { text: "hello" } });
    expect(client.error).toBeNull();
  });

  test("sendPrompt ignores empty text and does nothing without an active session", async () => {
    const client = makeClient();
    const fn = stubFetch({ result: { accepted: true } });

    client.sendPrompt("hi"); // no active session
    client.select("s1");
    client.sendPrompt("   "); // whitespace only

    expect(fn).not.toHaveBeenCalled();
  });

  test("a rejected command surfaces its reason rather than looking like success", async () => {
    const client = makeClient();
    stubFetch({ result: { accepted: false, reason: "session is busy" } });
    client.select("s1");

    await client.command("s1", "prompt", { text: "x" });

    expect(client.error).toBe("session is busy");
  });

  test("a transport failure surfaces the server's error message", async () => {
    const client = makeClient();
    stubFetch({ error: "not a member of this workspace" }, false, 403);

    await client.command("s1", "prompt", { text: "x" });

    expect(client.error).toBe("not a member of this workspace");
  });

  test("setModel posts the command and echoes locally so the picker doesn't snap back", async () => {
    const client = makeClient();
    const fn = stubFetch({ result: { accepted: true } });
    client.sessions = [{ id: "s1", title: "One" } as never];

    client.setModel("s1", "anthropic/claude-sonnet-4-5");

    expect(client.sessions[0]).toMatchObject({ model: "anthropic/claude-sonnet-4-5" });
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sessions/s1/commands");
    expect(JSON.parse(String(init.body))).toEqual({
      verb: "setModel",
      args: { model: "anthropic/claude-sonnet-4-5" },
    });
  });
});
