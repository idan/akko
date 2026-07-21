<script lang="ts">
  import { QuerySubscription } from "jazz-tools/svelte";
  import { app } from "@akko/schema";

  let { sessionId }: { sessionId: string } = $props();

  // Reactive query of the projected messages table for this session (doc 14).
  const rows = new QuerySubscription(() => app.messages.where({ sessionId }));
</script>

<div class="messages">
  <p class="jazz-note">Projected read model (Jazz messages table)</p>
  {#each rows.current ?? [] as m (m.id)}
    <div class="msg {m.role}">
      <div class="bubble">{m.text}</div>
    </div>
  {:else}
    <p class="empty">No projected messages yet.</p>
  {/each}
</div>