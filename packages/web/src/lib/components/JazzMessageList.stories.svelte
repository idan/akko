<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect } from "storybook/test";
  import JazzMessageList from "./JazzMessageList.svelte";

  const { Story } = defineMeta({
    title: "Chat/JazzMessageList",
    component: JazzMessageList,
    tags: ["autodocs"],
    parameters: { layout: "fullscreen" },
  });
</script>

<!--
  Rows come from the mocked @akko/schema fixtures keyed by sessionId
  (see .storybook/mocks/schema.ts): `sess_demo` is populated, anything else is empty.
  The `play` function turns this story into an addon-vitest browser test.
-->
<Story
  name="Projected"
  play={async ({ canvas }) => {
    await expect(canvas.findByText(/Projected read model/)).resolves.toBeInTheDocument();
    await expect(canvas.findByText(/never projected/)).resolves.toBeInTheDocument();
  }}
>
  {#snippet template()}
    <div style="height: 420px; width: 640px; display: flex; max-width: 100%;">
      <JazzMessageList sessionId="sess_demo" />
    </div>
  {/snippet}
</Story>

<Story
  name="Empty"
  play={async ({ canvas }) => {
    await expect(canvas.findByText(/No projected messages yet/)).resolves.toBeInTheDocument();
  }}
>
  {#snippet template()}
    <div style="height: 240px; width: 640px; display: flex; max-width: 100%;">
      <JazzMessageList sessionId="sess_none" />
    </div>
  {/snippet}
</Story>
