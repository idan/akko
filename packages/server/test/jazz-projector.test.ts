/**
 * Proves the Jazz projection path in-process (doc 14): the JazzProjector (as the worker
 * account) writes a public Conversation CoValue, and a *separate* account reads the
 * projected messages back — validating backend-projects -> Jazz -> client-reads without
 * a network sync server.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { createJazzTestAccount, setupJazzTestSync } from "jazz-tools/testing";
import { Conversation } from "@akko/schema";
import type { CommittedEntry, EntryId, PrincipalId, SessionId, SessionRef, WorkspaceId } from "@akko/core";
import { JazzProjector } from "../src/jazz-projector.ts";

/** Narrowed view of a loaded Conversation for test assertions. */
type LoadedConvo = {
  title: string;
  sessionId: string;
  messages: Array<{ role: string; text: string; authorId?: string }>;
} | null | undefined;
const loadConvo = async (id: string): Promise<LoadedConvo> =>
  (await Conversation.load(id, {
    loadAs: clientAccount,
    resolve: { messages: { $each: true } },
  })) as unknown as LoadedConvo;

let clientAccount: Awaited<ReturnType<typeof createJazzTestAccount>>;

beforeAll(async () => {
  await setupJazzTestSync();
  // Worker = active account (the projector writes as this account).
  await createJazzTestAccount({ isCurrentActiveAccount: true });
  // A separate account that will read the public projection (stands in for the browser).
  clientAccount = await createJazzTestAccount();
});

function ref(id: string, title: string): SessionRef {
  return {
    id: id as SessionId,
    workspaceId: "wsp_1" as WorkspaceId,
    ownerId: "owner" as PrincipalId,
    kind: "conversation",
    title,
    createdAt: 0,
    updatedAt: 0,
  };
}
function entry(id: string, msg: unknown, actorId?: string): CommittedEntry {
  return { id: id as EntryId, parentId: null, entry: msg, actorId: actorId as PrincipalId | undefined, ts: 1 };
}
const userMsg = (text: string) => ({ role: "user", content: text });
const assistantMsg = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("JazzProjector", () => {
  test("projects finalized messages into a public CoValue readable by another account", async () => {
    const projector = new JazzProjector({ publicRead: true });
    const r = ref("ses_p1", "Greeting");
    const jazzId = projector.ensureSession(r);
    expect(jazzId).toStartWith("co_");
    expect(projector.projectionId(r.id)).toBe(jazzId);

    await projector.onEntry(r.id, entry("e1", userMsg("my name is Ada"), "prn_alice"));
    await projector.onEntry(r.id, entry("e2", assistantMsg("Hi Ada")));

    const loaded = await loadConvo(jazzId);
    expect(loaded?.title).toBe("Greeting");
    expect(loaded?.sessionId).toBe("ses_p1");
    expect(loaded?.messages?.map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:my name is Ada",
      "assistant:Hi Ada",
    ]);
    expect(loaded?.messages?.[0]?.authorId).toBe("prn_alice");
    expect(loaded?.messages?.[1]?.authorId).toBeUndefined();
  });

  test("ignores non-conversation entries and unknown sessions", async () => {
    const projector = new JazzProjector({ publicRead: true });
    const r = ref("ses_p2", "X");
    projector.ensureSession(r);
    await projector.onEntry(r.id, entry("e1", { role: "toolResult", content: "x" }));
    await projector.onEntry("ses_unknown" as SessionId, entry("e2", userMsg("dropped")));

    const loaded = await loadConvo(projector.projectionId(r.id)!);
    expect(loaded?.messages?.length).toBe(0);
  });
});