<script lang="ts">
  import { onMount } from "svelte";
  import { createJazzClient, JazzSvelteProvider, type JazzClient } from "jazz-tools/svelte";
  import { AkkoClient } from "./lib/client.svelte.ts";
  import { JAZZ_APP_ID, JAZZ_SYNC, JAZZ_DEBUG } from "./lib/config.ts";
  import { currentUser, signOut, getJazzToken, decodeJwtPayload, type AuthedUser } from "./lib/auth-client.ts";
  import { startJazzTokenRefresh } from "./lib/jazz-token.ts";
  import JazzSessionList from "./lib/components/JazzSessionList.svelte";
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
  // has *successfully* resolved. Jazz is now the only read model (doc 15, unify step 3):
  // without it there is nothing to render, so a failure surfaces to the user and retries
  // rather than silently degrading to a blank app.
  let jazzClient = $state<JazzClient | null>(null);
  let jazzError = $state<string | null>(null);
  let stopTokenRefresh: (() => void) | undefined;
  // Bumped to re-run the effect after a failure — the read model is load-bearing now, so
  // "give up" is not an option; keep retrying while the user waits.
  let jazzAttempt = $state(0);
  $effect(() => {
    void jazzAttempt;
    if (user && !jazzClient) {
      void (async () => {
        try {
          const jwtToken = await getJazzToken();
          if (!jwtToken) {
            jazzError = "Could not get a read-model token. Are you signed in?";
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
          jazzError = null;
          jazzClient = client;
          // The JWT expires (15 min); Jazz is the only read model, so letting it lapse
          // freezes the UI with nothing to fall back to (doc 16).
          stopTokenRefresh?.();
          stopTokenRefresh = startJazzTokenRefresh({
            getToken: getJazzToken,
            apply: (t) => {
              if (JAZZ_DEBUG) console.log("[jazz] auth token refreshed");
              client.db.updateAuthToken(t); // lives on the Db, not the svelte wrapper
            },
            onError: (err) => console.warn("[jazz] token refresh failed; will retry", err),
          });
        } catch (err) {
          console.error("[jazz] client unavailable:", err);
          jazzError = `Read model unavailable at ${JAZZ_SYNC}. Is the sync server running? Retrying…`;
          setTimeout(() => (jazzAttempt += 1), 3000);
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
      void c.loadSessions();
      void c.loadModels();
      client = c;
    }
  }

  async function logout() {
    stopTokenRefresh?.();
    stopTokenRefresh = undefined;
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
        <!-- Session list straight off the Jazz read model: live across tabs/devices. -->
        <JazzSessionList
          workspaceId={WORKSPACE}
          activeId={c.activeSessionId}
          connected={true}
          onselect={selectSession}
          oncreate={() => void c.createSession()}
        />
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
      <JazzChatView client={c} onmenu={() => (sidebarOpen = !sidebarOpen)} />
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
  <div class="grid min-h-screen place-items-center p-4 text-center text-muted">
    {jazzError ?? "Connecting to the read model…"}
  </div>
{/if}

