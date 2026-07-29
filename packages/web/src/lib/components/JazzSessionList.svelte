<script lang="ts">
  import { QuerySubscription } from "jazz-tools/svelte";
  import { app } from "@akko/schema";
  import { JAZZ_DEBUG } from "../config.ts";
  import SessionList from "./SessionList.svelte";

  let { workspaceId, activeId = null, connected = false, onselect, oncreate, onrename }: {
    workspaceId: string;
    activeId?: string | null;
    connected?: boolean;
    onselect: (id: string) => void;
    onrename?: (id: string, title: string) => void;
    oncreate: () => void;
  } = $props();

  // The session list straight off the read model (doc 02/14): live across tabs, devices
  // and workspace members with no socket fan-out. Must live inside the Jazz provider.
  const rows = new QuerySubscription(() =>
    app.sessions.where({ workspaceId }).orderBy("updatedAt", "desc"),
  );

  const sessions = $derived(
    (rows.current ?? []).map((r) => ({ id: r.sessionId as string, title: (r.title as string) || undefined })),
  );

  $effect(() => {
    if (JAZZ_DEBUG) {
      console.log("[jazz] session list", { count: sessions.length, loading: rows.loading, error: rows.error });
    }
  });
</script>

<SessionList {sessions} {activeId} {connected} {onselect} {oncreate} {onrename} />
