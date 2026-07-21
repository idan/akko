<script lang="ts">
  import { Button, Separator } from "bits-ui";
  import type { AkkoClient } from "../client.svelte.ts";

  let { client, onselect, oncreate }: {
    client: AkkoClient;
    onselect: (id: string) => void;
    oncreate: () => void;
  } = $props();
</script>

<div class="list">
  <header class="list-head">
    <h1>Akko</h1>
    <Button.Root class="btn primary" onclick={oncreate}>New</Button.Root>
  </header>
  <Separator.Root class="sep" />
  <nav class="sessions">
    {#each client.sessions as s (s.id)}
      <button
        class="session"
        class:active={client.activeSessionId === s.id}
        onclick={() => onselect(s.id)}
      >
        {s.title ?? "Untitled"}
      </button>
    {:else}
      <p class="empty">No sessions yet</p>
    {/each}
  </nav>
  <footer class="status" class:online={client.connected}>
    {client.connected ? "● connected" : "○ offline"}
  </footer>
</div>