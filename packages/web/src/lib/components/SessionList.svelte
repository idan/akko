<script lang="ts">
  import { Button } from "bits-ui";

  /** Minimal shape the list renders — satisfied by both the WS client and Jazz rows. */
  export interface SessionListItem {
    id: string;
    title?: string;
  }

  let { sessions, activeId = null, connected = false, onselect, oncreate }: {
    sessions: SessionListItem[];
    activeId?: string | null;
    connected?: boolean;
    onselect: (id: string) => void;
    oncreate: () => void;
  } = $props();
</script>

<div class="list">
  <header class="list-head">
    <h1>Akko</h1>
    <Button.Root class="btn primary" onclick={oncreate}>New</Button.Root>
  </header>
  <hr class="sep" />
  <nav class="sessions">
    {#each sessions as s (s.id)}
      <button class="session" class:active={activeId === s.id} onclick={() => onselect(s.id)}>
        {s.title ?? "Untitled"}
      </button>
    {:else}
      <p class="empty">No sessions yet</p>
    {/each}
  </nav>
  <footer class="status" class:online={connected}>
    {connected ? "● connected" : "○ offline"}
  </footer>
</div>
