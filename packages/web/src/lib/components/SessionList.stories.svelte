<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { fn } from "storybook/test";
  import SessionList from "./SessionList.svelte";
  import type { AkkoClient } from "../client.svelte.ts";

  // SessionList only reads sessions/activeSessionId/connected — a plain stub is enough.
  function client(over: Partial<AkkoClient> = {}): AkkoClient {
    return { sessions: [], activeSessionId: null, connected: false, ...over } as unknown as AkkoClient;
  }

  const populated = client({
    connected: true,
    activeSessionId: "s2",
    sessions: [
      { id: "s1", title: "Roadmap review" },
      { id: "s2", title: "Jazz projection slice" },
      { id: "s3", title: "Untitled" },
    ] as AkkoClient["sessions"],
  });

  const { Story } = defineMeta({
    title: "Chat/SessionList",
    component: SessionList,
    tags: ["autodocs"],
    args: { onselect: fn(), oncreate: fn() },
    parameters: { layout: "fullscreen" },
  });
</script>

<!-- The sidebar is a full-height 280px column in the app grid. -->
<Story name="Populated">
  {#snippet template(args)}
    <div style="height: 100vh; width: 280px; background: var(--panel);">
      <SessionList {...args} client={populated} />
    </div>
  {/snippet}
</Story>

<Story name="Empty (offline)">
  {#snippet template(args)}
    <div style="height: 100vh; width: 280px; background: var(--panel);">
      <SessionList {...args} client={client()} />
    </div>
  {/snippet}
</Story>
