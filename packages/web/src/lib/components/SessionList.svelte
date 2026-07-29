<script lang="ts">
  import { Button } from "bits-ui";

  /** Minimal shape the list renders — satisfied by the Jazz `sessions` rows. */
  export interface SessionListItem {
    id: string;
    title?: string;
  }

  let { sessions, activeId = null, connected = false, onselect, oncreate, onrename }: {
    sessions: SessionListItem[];
    activeId?: string | null;
    connected?: boolean;
    onselect: (id: string) => void;
    oncreate: () => void;
    /** Omitted in read-only contexts (e.g. stories); renaming is then unavailable. */
    onrename?: (id: string, title: string) => void;
  } = $props();

  /** Id of the row being renamed, plus its draft title. */
  let editingId = $state<string | null>(null);
  let draft = $state("");

  function startRename(s: SessionListItem) {
    editingId = s.id;
    draft = s.title ?? "";
  }

  function commit() {
    const id = editingId;
    const title = draft.trim();
    editingId = null;
    // An unchanged or emptied title is a cancel, not a command — don't spend a round trip.
    if (!id || !title) return;
    if (title === (sessions.find((s) => s.id === id)?.title ?? "")) return;
    onrename?.(id, title);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      editingId = null;
    }
  }
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
      {#if editingId === s.id}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="w-full rounded-[10px] border border-accent bg-panel-2 px-3 py-2.5 text-text outline-none"
          aria-label="Session title"
          bind:value={draft}
          {onkeydown}
          onblur={commit}
          autofocus
        />
      {:else}
        <div class="group relative flex items-center">
          <button
            class="w-full truncate rounded-[10px] border-0 bg-transparent py-2.5 pl-3 pr-9 text-left
                   text-text hover:bg-panel-2
                   aria-[current=true]:bg-panel-2 aria-[current=true]:outline aria-[current=true]:outline-border"
            aria-current={activeId === s.id}
            onclick={() => onselect(s.id)}
            ondblclick={() => onrename && startRename(s)}
          >
            {s.title ?? "Untitled"}
          </button>
          {#if onrename}
            <!-- Always reachable for keyboard/touch; only shown on hover or focus, since
                 a permanently visible control on every row is noise. -->
            <button
              class="absolute right-1 rounded-md px-1.5 py-1 text-xs text-muted opacity-0
                     hover:bg-panel hover:text-text focus:opacity-100 group-hover:opacity-100"
              aria-label={`Rename ${s.title ?? "Untitled"}`}
              onclick={() => startRename(s)}
            >
              ✎
            </button>
          {/if}
        </div>
      {/if}
    {:else}
      <p class="px-3 py-2 text-muted">No sessions yet</p>
    {/each}
  </nav>
  <footer class="pt-2 text-xs {connected ? 'text-online' : 'text-muted'}">
    {connected ? "● connected" : "○ offline"}
  </footer>
</div>
