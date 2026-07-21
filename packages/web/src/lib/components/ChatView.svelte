<script lang="ts">
  import type { AkkoClient } from "../client.svelte.ts";
  import MessageList from "./MessageList.svelte";
  import Composer from "./Composer.svelte";

  let { client, onmenu }: { client: AkkoClient; onmenu: () => void } = $props();

  const active = $derived(client.sessions.find((s) => s.id === client.activeSessionId));
</script>

<div class="chat">
  <header class="chat-head">
    <button class="menu" onclick={onmenu} aria-label="Toggle sessions">☰</button>
    <h2>{active?.title ?? (client.activeSessionId ? "Session" : "Akko")}</h2>
  </header>

  {#if client.activeSessionId}
    <MessageList conversation={client.activeConversation} />
    <Composer onsend={(t) => client.sendPrompt(t)} />
  {:else}
    <div class="placeholder">Create or select a session to begin.</div>
  {/if}

  {#if client.error}
    <div class="error" role="alert">{client.error}</div>
  {/if}
</div>