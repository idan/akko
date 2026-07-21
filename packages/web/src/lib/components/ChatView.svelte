<script lang="ts">
  import type { AkkoClient } from "../client.svelte.ts";
  import MessageList from "./MessageList.svelte";
  import JazzMessageList from "./JazzMessageList.svelte";
  import Composer from "./Composer.svelte";

  let { client, onmenu }: { client: AkkoClient; onmenu: () => void } = $props();

  const active = $derived(client.sessions.find((s) => s.id === client.activeSessionId));
  const jazzId = $derived(client.activeJazzId);

  // "live" = WS stream (token-by-token). "jazz" = projected read model (finalized).
  let view = $state<"live" | "jazz">("live");
</script>

<div class="chat">
  <header class="chat-head">
    <button class="menu" onclick={onmenu} aria-label="Toggle sessions">☰</button>
    <h2>{active?.title ?? (client.activeSessionId ? "Session" : "Akko")}</h2>
    {#if client.activeSessionId && jazzId}
      <div class="seg">
        <button class:on={view === "live"} onclick={() => (view = "live")}>Live</button>
        <button class:on={view === "jazz"} onclick={() => (view = "jazz")}>Jazz</button>
      </div>
    {/if}
  </header>

  {#if client.activeSessionId}
    {#if view === "jazz" && jazzId}
      <JazzMessageList {jazzId} />
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