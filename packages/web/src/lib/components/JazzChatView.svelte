<script lang="ts">
  import { QuerySubscription } from "jazz-tools/svelte";
  import { app } from "@akko/schema";
  import type { AkkoClient } from "../client.svelte.ts";
  import ChatView from "./ChatView.svelte";

  let { client, onmenu }: { client: AkkoClient; onmenu: () => void } = $props();

  // Session metadata (title/model) straight off the read model, so the header stays in
  // sync across tabs — `client.sessions` only holds what this tab fetched over HTTP.
  // Must live inside the Jazz provider. "" matches nothing when no session is selected.
  const rows = new QuerySubscription(() =>
    app.sessions.where({ sessionId: client.activeSessionId ?? "" }),
  );

  const session = $derived.by(() => {
    const r = (rows.current ?? [])[0] as { title?: string; model?: string } | undefined;
    if (!r) return undefined;
    return { title: (r.title as string) || undefined, model: (r.model as string) || undefined };
  });
</script>

<ChatView {client} {onmenu} {session} />
