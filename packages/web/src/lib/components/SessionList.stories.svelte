<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { fn } from "storybook/test";
  import SessionList from "./SessionList.svelte";

  // SessionList is presentational: plain data in, callbacks out (fed by the WS client
  // or the Jazz read model in the app).
  const populated = {
    status: "live" as const,
    activeId: "s2",
    sessions: [
      { id: "s1", title: "Roadmap review" },
      { id: "s2", title: "Jazz projection slice" },
      { id: "s3", title: "Untitled" },
    ],
  };

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
      <SessionList {...args} {...populated} />
    </div>
  {/snippet}
</Story>

<Story name="Empty (offline)">
  {#snippet template(args)}
    <div style="height: 100vh; width: 280px; background: var(--panel);">
      <SessionList {...args} sessions={[]} />
    </div>
  {/snippet}
</Story>
