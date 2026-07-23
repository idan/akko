<script lang="ts">
  import type { AkkoClient } from "../client.svelte.ts";
  import { JAZZ_ENABLED } from "../config.ts";
  import MessageList from "./MessageList.svelte";
  import JazzMessageList from "./JazzMessageList.svelte";
  import Composer from "./Composer.svelte";

  let { client, onmenu }: { client: AkkoClient; onmenu: () => void } = $props();

  const active = $derived(client.sessions.find((s) => s.id === client.activeSessionId));
  const showJazz = $derived(JAZZ_ENABLED && !!client.activeJazzId);

  // "live" = WS stream (token-by-token). "jazz" = projected read model (finalized).
  let view = $state<"live" | "jazz">("live");

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
    {#if client.activeSessionId && showJazz}
      <div class="seg">
        <button class:on={view === "live"} onclick={() => (view = "live")}>Live</button>
        <button class:on={view === "jazz"} onclick={() => (view = "jazz")}>Jazz</button>
      </div>
    {/if}
  </header>

  {#if client.activeSessionId}
    {#if view === "jazz" && showJazz}
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