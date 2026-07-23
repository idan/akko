<script lang="ts">
  import { onMount } from "svelte";
  import { LocalFirstAuth, createJazzClient, JazzSvelteProvider, type JazzClient } from "jazz-tools/svelte";
  import { AkkoClient } from "./lib/client.svelte.ts";
  import { JAZZ_ENABLED, JAZZ_APP_ID, JAZZ_SYNC } from "./lib/config.ts";
  import { currentUser, signOut, type AuthedUser } from "./lib/auth-client.ts";
  import SessionList from "./lib/components/SessionList.svelte";
  import ChatView from "./lib/components/ChatView.svelte";
  import Auth from "./lib/components/Auth.svelte";

  // The workspace is the single dev workspace for now (doc 16); the principal is the
  // authenticated Better Auth user.
  const WORKSPACE = "wsp_dev";

  // undefined = still checking the session; null = signed out; user = authenticated.
  let user = $state<AuthedUser | null | undefined>(undefined);
  let client = $state<AkkoClient | null>(null);
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
    void refreshSession();
  });

  async function refreshSession() {
    user = await currentUser();
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
  <div class="app" class:sidebar-open={sidebarOpen}>
    <aside class="sidebar">
      <div class="list-wrap">
        <SessionList client={c} onselect={selectSession} oncreate={() => void c.createSession()} />
      </div>
      <div class="account">
        <span class="who" title={user?.email}>{user?.name}</span>
        <button class="signout" onclick={logout}>Sign out</button>
      </div>
    </aside>
    <main class="main">
      <ChatView client={c} onmenu={() => (sidebarOpen = !sidebarOpen)} />
    </main>
  </div>
{/snippet}

{#if user === undefined}
  <div class="loading">Loading…</div>
{:else if !user || !client}
  <Auth onAuthed={refreshSession} />
{:else if jazzClient}
  <JazzSvelteProvider client={jazzClient}>
    {@render shell(client)}
  </JazzSvelteProvider>
{:else}
  {@render shell(client)}
{/if}

<style>
  .loading {
    display: grid;
    place-items: center;
    min-height: 100vh;
    color: var(--muted, #9a9a9a);
  }
  .account {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    border-top: 1px solid var(--border, #2a2a2a);
    font-size: 0.85rem;
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }
  .list-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .who {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted, #9a9a9a);
  }
  .signout {
    background: none;
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 6px;
    color: inherit;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 0.8rem;
  }
</style>
