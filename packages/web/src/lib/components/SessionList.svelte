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

<div class="flex h-full flex-col gap-2 p-3">
  <header class="flex items-center justify-between">
    <h1 class="m-0 text-lg">Akko</h1>
    <Button.Root class="btn btn-primary" onclick={oncreate}>New</Button.Root>
  </header>
  <hr class="h-px border-0 bg-border" />
  <!-- min-h-0 is load-bearing: without it this flex child refuses to shrink, the list
       never scrolls internally and the page scrolls instead (see App.svelte). -->
  <nav class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
    {#each sessions as s (s.id)}
      <button
        class="w-full truncate rounded-[10px] border-0 bg-transparent px-3 py-2.5 text-left
               text-text hover:bg-panel-2
               aria-[current=true]:bg-panel-2 aria-[current=true]:outline aria-[current=true]:outline-border"
        aria-current={activeId === s.id}
        onclick={() => onselect(s.id)}
      >
        {s.title ?? "Untitled"}
      </button>
    {:else}
      <p class="px-3 py-2 text-muted">No sessions yet</p>
    {/each}
  </nav>
  <footer class="pt-2 text-xs {connected ? 'text-online' : 'text-muted'}">
    {connected ? "● connected" : "○ offline"}
  </footer>
</div>
