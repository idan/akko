<script lang="ts">
  import { QuerySubscription } from "jazz-tools/svelte";
  import { app } from "@akko/schema";
  import { JAZZ_DEBUG } from "../config.ts";
  import SessionList from "./SessionList.svelte";

  let { workspaceId, activeId = null, onselect, oncreate, onrename }: {
    workspaceId: string;
    activeId?: string | null;
    onselect: (id: string) => void;
    onrename?: (id: string, title: string) => void;
    oncreate: () => void;
  } = $props();

  // The session list straight off the read model (doc 02/14): live across tabs, devices
  // and workspace members with no socket fan-out. Must live inside the Jazz provider.
  const rows = new QuerySubscription(() =>
    // `kind` filters out subagents: they are real sessions (doc 03) but not
    // conversations, so they do not belong in the sidebar.
    app.sessions.where({ workspaceId, kind: "conversation" }).orderBy("updatedAt", "desc"),
  );

  const sessions = $derived(
    (rows.current ?? []).map((r) => ({ id: r.sessionId as string, title: (r.title as string) || undefined })),
  );

  // Report the read model's real state rather than a hardcoded `true`. Jazz exposes no
  // connection observable, but the subscription itself is the honest signal: if the query
  // is erroring or has never resolved, the list is not live — which is exactly the case
  // where a green "connected" dot is worst, because it says the empty list is the truth.
  const status = $derived(rows.error ? "error" : rows.current === undefined ? "connecting" : "live");

  $effect(() => {
    if (JAZZ_DEBUG) {
      console.log("[jazz] session list", { count: sessions.length, loading: rows.loading, error: rows.error });
    }
  });
</script>

<SessionList {sessions} {activeId} {status} {onselect} {oncreate} {onrename} />
