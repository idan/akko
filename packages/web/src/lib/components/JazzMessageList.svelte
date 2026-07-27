<script lang="ts">
  import { QuerySubscription } from "jazz-tools/svelte";
  import { app } from "@akko/schema";

  let { sessionId }: { sessionId: string } = $props();

  // Two reactive queries (doc 08): finalized messages + the ephemeral live `activity`
  // (thinking → streaming). Rendering both makes the Jazz view feel as live as the WS.
  const rows = new QuerySubscription(() => app.messages.where({ sessionId }));
  const activity = new QuerySubscription(() => app.activity.where({ sessionId }));

  let container: HTMLDivElement | undefined = $state();
  const live = $derived((activity.current ?? [])[0] as { kind?: string; text?: string } | undefined);

  // Tail the latest content as rows / the streaming bubble update.
  $effect(() => {
    const _ = (rows.current?.length ?? 0) + (live?.text?.length ?? 0) + (live?.kind ? 1 : 0);
    void _;
    if (container) container.scrollTop = container.scrollHeight;
  });
</script>

<div class="messages" bind:this={container}>
  <p class="jazz-note">Projected read model (Jazz messages table)</p>
  {#each rows.current ?? [] as m (m.id)}
    <div class="msg {m.role}">
      <div class="bubble">{m.text}</div>
    </div>
  {/each}
  {#if live?.kind === "streaming"}
    <div class="msg assistant">
      <div class="bubble">{live.text}<span class="cursor">▋</span></div>
    </div>
  {:else if live?.kind === "thinking"}
    <div class="msg assistant">
      <div class="bubble thinking" role="status" aria-label="Assistant is thinking">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>
  {/if}
  {#if (rows.current ?? []).length === 0 && !live}
    <p class="empty">No projected messages yet.</p>
  {/if}
</div>
