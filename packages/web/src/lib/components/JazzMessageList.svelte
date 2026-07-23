<script lang="ts">
  import { QuerySubscription } from "jazz-tools/svelte";
  import { app } from "@akko/schema";

  let { sessionId }: { sessionId: string } = $props();

  // Reactive query of the projected messages table for this session (doc 14).
  const rows = new QuerySubscription(() => app.messages.where({ sessionId }));

  let container: HTMLDivElement | undefined = $state();

  // Tail the latest projected message as rows arrive (mirrors MessageList).
  $effect(() => {
    const _ = rows.current?.length;
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
  {:else}
    <p class="empty">No projected messages yet.</p>
  {/each}
</div>