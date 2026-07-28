<script lang="ts">
  import { onMount } from "svelte";
  import { createJazzClient, JazzSvelteProvider, type JazzClient } from "jazz-tools/svelte";
  import { AkkoClient } from "./lib/client.svelte.ts";
  import { JAZZ_ENABLED, JAZZ_APP_ID, JAZZ_SYNC, JAZZ_DEBUG } from "./lib/config.ts";
  import { currentUser, signOut, getJazzToken, decodeJwtPayload, type AuthedUser } from "./lib/auth-client.ts";
  import SessionList from "./lib/components/SessionList.svelte";
  import JazzSessionList from "./lib/components/JazzSessionList.svelte";
  import ChatView from "./lib/components/ChatView.svelte";
  import JazzChatView from "./lib/components/JazzChatView.svelte";
  import Auth from "./lib/components/Auth.svelte";

  // The workspace is the single dev workspace for now (doc 16); the principal is the
  // authenticated Better Auth user.
  const WORKSPACE = "wsp_dev";

  // undefined = still checking the session; null = signed out; user = authenticated.
  let user = $state<AuthedUser | null | undefined>(undefined);
  let client = $state<AkkoClient | null>(null);
  let sidebarOpen = $state(true);

  // Jazz 2.0 client (opt-in): connects to the sync server authenticated with the Better
  // Auth JWT, so the read-ACL row policy filters projected messages by workspace (doc 16).
  // Decoupled from the core app: we only wrap the shell in the provider once the client
  // has *successfully* resolved. A Jazz failure (e.g. JWT rejected by the sync server) is
  // logged and leaves the read model disabled — it must never block the WS or the shell.
  let jazzClient = $state<JazzClient | null>(null);
  $effect(() => {
    if (JAZZ_ENABLED && user && !jazzClient) {
      void (async () => {
        try {
          const jwtToken = await getJazzToken();
          if (!jwtToken) {
            console.warn("[jazz] no token (not authenticated?) — read model disabled");
            return;
          }
          if (JAZZ_DEBUG) console.log("[jazz] connecting to", JAZZ_SYNC, "app", JAZZ_APP_ID);
          if (JAZZ_DEBUG) console.log("[jazz] token payload:", JSON.stringify(decodeJwtPayload(jwtToken)));
          if (JAZZ_DEBUG) console.log("[jazz] raw token (for scripts/jazz-probe.mjs):", jwtToken);
          // `driver: memory` is deliberate. Jazz is a **disposable projection** of SQLite
          // (doc 04/14), so client-side persistence buys nothing — and the default
          // (`persistent`) puts the browser on an OPFS store behind a SharedWorker that
          // outlives the dev sync server (which is `--in-memory` and wiped on restart).
          // That stale local store is why queries succeeded but returned 0 rows. Memory
          // makes the client re-sync from the server on every load.
          const client = await createJazzClient({
            appId: JAZZ_APP_ID,
            serverUrl: JAZZ_SYNC,
            jwtToken,
            driver: { type: "memory" },
          });
          if (JAZZ_DEBUG) console.log("[jazz] connected; session:", JSON.stringify(client.session));
          jazzClient = client;
        } catch (err) {
          console.error("[jazz] client unavailable (core app unaffected):", err);
        }
      })();
    }
  });

  onMount(() => {
    void refreshSession();
  });

  async function refreshSession() {
    let resolved: AuthedUser | null;
    try {
      resolved = await currentUser();
    } catch (err) {
      // Backend not reachable yet (e.g. the gateway is still booting behind the Jazz
      // sync server under dev:jazz). Stay on "Loading…" and retry until it answers.
      console.warn("backend unreachable, retrying session check…", err);
      setTimeout(() => void refreshSession(), 1500);
      return;
    }
    user = resolved;
    if (user && !client) {
      const c = new AkkoClient({ principalId: user.id, workspaceId: WORKSPACE });
      c.connect();
      void c.loadSessions();
      void c.loadModels();
      client = c;
    }
  }

  async function logout() {
    await signOut();
    client = null;
    user = null;
  }

  function selectSession(id: string) {
    client?.select(id);
    if (window.matchMedia("(max-width: 720px)").matches) sidebarOpen = false;
  }
</script>

{#snippet shell(c: AkkoClient)}
  <!-- One pane below `pane`, two above. `sidebarOpen` only decides which pane shows on
       narrow screens; at pane width and up both are always visible. -->
  <div class="grid h-[100dvh] grid-cols-1 pane:grid-cols-[280px_1fr]">
    <!-- overflow-hidden + min-h-0 below keep scrolling *inside* the list. Losing that
         chain (e.g. by making this `block`) makes the page scroll instead, which reads
         as "selecting a session does nothing" on mobile. -->
    <aside
      class="min-w-0 flex-col overflow-hidden border-r border-border bg-panel pane:flex
             {sidebarOpen ? 'flex' : 'hidden'}"
    >
      <div class="flex min-h-0 flex-1 flex-col">
        {#if jazzClient}
          <!-- Session list straight off the Jazz read model: live across tabs/devices. -->
          <JazzSessionList
            workspaceId={WORKSPACE}
            activeId={c.activeSessionId}
            connected={c.connected}
            onselect={selectSession}
            oncreate={() => void c.createSession()}
          />
        {:else}
          <SessionList
            sessions={c.sessions}
            activeId={c.activeSessionId}
            connected={c.connected}
            onselect={selectSession}
            oncreate={() => void c.createSession()}
          />
        {/if}
      </div>
      <div class="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2.5 text-[0.85rem]">
        <span class="min-w-0 truncate text-muted" title={user?.email}>{user?.name}</span>
        <button
          class="shrink-0 cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-1 text-xs text-muted hover:text-text"
          onclick={logout}
        >
          Sign out
        </button>
      </div>
    </aside>
    <main class="min-w-0 pane:flex {sidebarOpen ? 'hidden' : 'flex'}">
      {#if jazzClient}
        <JazzChatView client={c} onmenu={() => (sidebarOpen = !sidebarOpen)} />
      {:else}
        <ChatView client={c} jazzReady={false} onmenu={() => (sidebarOpen = !sidebarOpen)} />
      {/if}
    </main>
  </div>
{/snippet}

{#if user === undefined}
  <div class="grid min-h-screen place-items-center text-muted">Loading…</div>
{:else if !user || !client}
  <Auth onAuthed={refreshSession} />
{:else if jazzClient}
  <JazzSvelteProvider client={jazzClient}>
    {@render shell(client)}
  </JazzSvelteProvider>
{:else}
  {@render shell(client)}
{/if}

