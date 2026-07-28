<script lang="ts">
  import type { AkkoClient } from "../client.svelte.ts";
  import JazzMessageList from "./JazzMessageList.svelte";
  import Composer from "./Composer.svelte";

  let { client, onmenu, session = undefined }: {
    client: AkkoClient;
    onmenu: () => void;
    /** Session metadata from the read model (doc 14). */
    session?: { title?: string; model?: string };
  } = $props();

  // Prefer the projected row: `client.sessions` only holds what this tab fetched over
  // HTTP, so a session created in another tab is missing from it (doc 14).
  const active = $derived(session ?? client.sessions.find((s) => s.id === client.activeSessionId));

  function onModelChange(e: Event) {
    const value = (e.currentTarget as HTMLSelectElement).value;
    if (client.activeSessionId && value) client.setModel(client.activeSessionId, value);
  }
</script>

<div class="flex h-[100dvh] min-w-0 flex-1 flex-col">
  <header class="flex items-center gap-2.5 border-b border-border bg-panel px-4 py-3">
    <!-- Only a one-pane concern: at pane width and up both panes are visible. -->
    <button class="border-0 bg-transparent text-xl text-text pane:hidden" onclick={onmenu} aria-label="Toggle sessions">☰</button>
    <h2 class="m-0 truncate text-base">{active?.title ?? (client.activeSessionId ? "Session" : "Akko")}</h2>
    {#if client.activeSessionId && client.models.length > 0}
      <select
        class="ml-auto max-w-[200px] rounded-lg border border-border bg-panel-2 px-2 py-1
               font-[inherit] text-[13px] text-text"
        aria-label="Model"
        value={active?.model ?? ""}
        onchange={onModelChange}
      >
        {#if !active?.model}<option value="" disabled>Model…</option>{/if}
        {#each client.models as m (m.provider + "/" + m.id)}
          <option value={`${m.provider}/${m.id}`}>{m.name}</option>
        {/each}
      </select>
    {/if}
  </header>

  {#if client.activeSessionId}
    <JazzMessageList sessionId={client.activeSessionId} />
    <Composer onsend={(t) => client.sendPrompt(t)} />
  {:else}
    <div class="grid flex-1 place-items-center text-muted">Create or select a session to begin.</div>
  {/if}

  {#if client.error}
    <div class="border-t border-border px-4 py-2 text-danger" role="alert">{client.error}</div>
  {/if}
</div>