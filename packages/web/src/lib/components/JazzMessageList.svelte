<script lang="ts">
  import { QuerySubscription } from "jazz-tools/svelte";
  import { app } from "@akko/schema";
  import { JAZZ_DEBUG } from "../config.ts";
  import MessageBubble from "./MessageBubble.svelte";

  let { sessionId }: { sessionId: string } = $props();

  // Two reactive queries (doc 08): finalized messages + the ephemeral live `activity`
  // (in-flight user prompt, thinking, streaming). Rendering both makes the Jazz view
  // feel as live as the WS. Messages are ordered by `createdAt` — row ids are
  // content-derived (not insertion-ordered), so ordering must be explicit.
  const rows = new QuerySubscription(() => app.messages.where({ sessionId }).orderBy("createdAt"));
  const activity = new QuerySubscription(() => app.activity.where({ sessionId }));

  let container: HTMLDivElement | undefined = $state();
  // The activity row is retired to `kind: "idle"` between turns (never deleted — Jazz
  // deletes are tombstones), so treat idle as "nothing in flight".
  const current = $derived(
    (activity.current ?? [])[0] as
      | { kind?: string; userText?: string; text?: string; toolLabel?: string }
      | undefined,
  );
  const live = $derived(current && current.kind !== "idle" ? current : undefined);

  // Diagnostics: surface query errors + row/activity churn (VITE_JAZZ_DEBUG=1).
  $effect(() => {
    if (!JAZZ_DEBUG) return;
    console.log("[jazz] view", sessionId, {
      messages: rows.current?.length ?? 0,
      loadingMessages: rows.loading,
      messagesError: rows.error,
      activity: live ? { kind: live.kind, userLen: live.userText?.length, textLen: live.text?.length } : null,
      activityError: activity.error,
    });
  });

  // Tail the latest content as rows / the streaming bubble update.
  $effect(() => {
    const _ = (rows.current?.length ?? 0) + (live?.text?.length ?? 0) + (live?.userText?.length ?? 0);
    void _;
    if (container) container.scrollTop = container.scrollHeight;
  });
</script>

<div class="flex flex-1 flex-col gap-2.5 overflow-y-auto p-4" bind:this={container}>
  {#each rows.current ?? [] as m (m.id)}
    <MessageBubble role={m.role} text={m.text} />
  {/each}
  {#if live?.userText}
    <MessageBubble role="user" text={live.userText} />
  {/if}
  <!-- Streamed text and a running tool coexist: a turn often says "I'll look into X"
       and then calls a tool. Rendering them as alternatives made the sentence disappear
       when the tool started and reappear once the message committed. -->
  {#if live?.kind === "thinking"}
    <MessageBubble role="assistant" thinking />
  {:else}
    {#if live?.text}
      <MessageBubble role="assistant" text={live.text} streaming={live.kind === "streaming"} />
    {/if}
    {#if live?.kind === "tool"}
      <MessageBubble role="tool" text={live.toolLabel ?? ""} working />
    {/if}
  {/if}
  {#if (rows.current ?? []).length === 0 && !live}
    <p class="px-3 py-2 text-muted">No messages yet.</p>
  {/if}
</div>
