<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { fn } from "storybook/test";
  import Composer from "./Composer.svelte";

  const { Story } = defineMeta({
    title: "Chat/Composer",
    component: Composer,
    tags: ["autodocs"],
    args: { onsend: fn() },
    parameters: { layout: "padded" },
  });
</script>

<!-- Composer is width-driven; give it a realistic chat column. -->
<Story name="Default">
  {#snippet template(args)}
    <div style="width: 640px; max-width: 100%;">
      <Composer {...args} />
    </div>
  {/snippet}
</Story>
