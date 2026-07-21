<script lang="ts">
  import { onMount } from "svelte";
  import { JazzSvelteProvider } from "jazz-tools/svelte";
  import { AkkoClient } from "./lib/client.svelte.ts";
  import { JAZZ_SYNC } from "./lib/config.ts";
  import SessionList from "./lib/components/SessionList.svelte";
  import ChatView from "./lib/components/ChatView.svelte";

  // Dev identity — matches the default workspace booted by `@akko/server` main.ts.
  const PRINCIPAL = "prn_dev";
  const WORKSPACE = "wsp_dev";

  const client = new AkkoClient({ principalId: PRINCIPAL, workspaceId: WORKSPACE });
  let sidebarOpen = $state(true);

  onMount(() => {
    client.connect();
    void client.loadSessions();
  });

  function selectSession(id: string) {
    client.select(id);
    if (window.matchMedia("(max-width: 720px)").matches) sidebarOpen = false;
  }
</script>

<!-- Guest mode: reads public projection CoValues without full auth (doc 14). -->
<JazzSvelteProvider sync={{ peer: JAZZ_SYNC as `ws://${string}` }} guestMode={true}>
  <div class="app" class:sidebar-open={sidebarOpen}>
    <aside class="sidebar">
      <SessionList {client} onselect={selectSession} oncreate={() => void client.createSession()} />
    </aside>
    <main class="main">
      <ChatView {client} onmenu={() => (sidebarOpen = !sidebarOpen)} />
    </main>
  </div>
</JazzSvelteProvider>