<script lang="ts">
  import { onMount } from "svelte";
  import { LocalFirstAuth, createJazzClient, JazzSvelteProvider, type JazzClient } from "jazz-tools/svelte";
  import { AkkoClient } from "./lib/client.svelte.ts";
  import { JAZZ_ENABLED, JAZZ_APP_ID, JAZZ_SYNC } from "./lib/config.ts";
  import SessionList from "./lib/components/SessionList.svelte";
  import ChatView from "./lib/components/ChatView.svelte";

  // Dev identity — matches the default workspace booted by `@akko/server` main.ts.
  const PRINCIPAL = "prn_dev";
  const WORKSPACE = "wsp_dev";

  const client = new AkkoClient({ principalId: PRINCIPAL, workspaceId: WORKSPACE });
  let sidebarOpen = $state(true);

  // Jazz 2.0 client (opt-in): local-first auth, connected to the sync server (doc 14).
  const auth = JAZZ_ENABLED ? new LocalFirstAuth() : null;
  let jazzClient = $state<Promise<JazzClient> | null>(null);
  $effect(() => {
    if (JAZZ_ENABLED && auth?.secret && !jazzClient) {
      jazzClient = createJazzClient({ appId: JAZZ_APP_ID, serverUrl: JAZZ_SYNC, secret: auth.secret });
    }
  });

  onMount(() => {
    client.connect();
    void client.loadSessions();
    void client.loadModels();
  });

  function selectSession(id: string) {
    client.select(id);
    if (window.matchMedia("(max-width: 720px)").matches) sidebarOpen = false;
  }
</script>

{#snippet shell()}
  <div class="app" class:sidebar-open={sidebarOpen}>
    <aside class="sidebar">
      <SessionList {client} onselect={selectSession} oncreate={() => void client.createSession()} />
    </aside>
    <main class="main">
      <ChatView {client} onmenu={() => (sidebarOpen = !sidebarOpen)} />
    </main>
  </div>
{/snippet}

{#if jazzClient}
  <JazzSvelteProvider client={jazzClient}>
    {@render shell()}
  </JazzSvelteProvider>
{:else}
  {@render shell()}
{/if}