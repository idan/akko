<script lang="ts">
  import type { AkkoClient } from "../client.svelte.ts";
  import MessageList from "./MessageList.svelte";
  import JazzMessageList from "./JazzMessageList.svelte";
  import Composer from "./Composer.svelte";

  let { client, onmenu, jazzReady = false, session = undefined }: {
    client: AkkoClient;
    onmenu: () => void;
    /** True when a Jazz provider is mounted — then the read model is THE view (doc 15). */
    jazzReady?: boolean;
    /** Session metadata from the read model. Falls back to the WS client's copy. */
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

<div class="chat">
  <header class="chat-head">
    <button class="menu" onclick={onmenu} aria-label="Toggle sessions">☰</button>
    <h2>{active?.title ?? (client.activeSessionId ? "Session" : "Akko")}</h2>
    {#if client.activeSessionId && client.models.length > 0}
      <select class="model" aria-label="Model" value={active?.model ?? ""} onchange={onModelChange}>
        {#if !active?.model}<option value="" disabled>Model…</option>{/if}
        {#each client.models as m (m.provider + "/" + m.id)}
          <option value={`${m.provider}/${m.id}`}>{m.name}</option>
        {/each}
      </select>
    {/if}
  </header>

  {#if client.activeSessionId}
    <!-- Jazz is the read model when a provider is mounted; the WS reducer view is the
         fallback for the no-Jazz setup (doc 15, unify step 2). -->
    {#if jazzReady}
      <JazzMessageList sessionId={client.activeSessionId} />
    {:else}
      <MessageList conversation={client.activeConversation} />
    {/if}
    <Composer onsend={(t) => client.sendPrompt(t)} />
  {:else}
    <div class="placeholder">Create or select a session to begin.</div>
  {/if}

  {#if client.error}
    <div class="error" role="alert">{client.error}</div>
  {/if}
</div>