<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import MessageList from "./MessageList.svelte";
  import type { ConversationState } from "../conversation.ts";

  const { Story } = defineMeta({
    title: "Chat/MessageList",
    component: MessageList,
    tags: ["autodocs"],
  });

  const conversation: ConversationState = {
    messages: [
      { id: "m1", role: "user", text: "What's the plan for the Jazz projection slice?", streaming: false },
      {
        id: "m2",
        role: "assistant",
        text: "Verify the browser read path, replace the dev-permissive policy with workspace read-ACL, then add a gated integration test.",
        streaming: false,
      },
      { id: "m3", role: "user", text: "Great — start with the read path.", streaming: false },
    ],
  };

  const streaming: ConversationState = {
    messages: [
      { id: "m1", role: "user", text: "Stream me a reply.", streaming: false },
      { id: "m2", role: "assistant", text: "Sure, here is the answer as it arrives", streaming: true },
    ],
  };

  const thinking: ConversationState = {
    messages: [{ id: "m1", role: "user", text: "What's the plan?", streaming: false }],
    awaiting: true,
  };
</script>

<!-- MessageList fills its parent (flex:1 + scroll); give it a bounded chat pane. -->
<Story name="Conversation">
  {#snippet template()}
    <div style="height: 420px; width: 640px; display: flex; max-width: 100%;">
      <MessageList {conversation} />
    </div>
  {/snippet}
</Story>

<Story name="Streaming">
  {#snippet template()}
    <div style="height: 240px; width: 640px; display: flex; max-width: 100%;">
      <MessageList conversation={streaming} />
    </div>
  {/snippet}
</Story>

<Story name="Empty">
  {#snippet template()}
    <div style="height: 240px; width: 640px; display: flex; max-width: 100%;">
      <MessageList conversation={{ messages: [] }} />
    </div>
  {/snippet}
</Story>

<Story name="Thinking">
  {#snippet template()}
    <div style="height: 240px; width: 640px; display: flex; max-width: 100%;">
      <MessageList conversation={thinking} />
    </div>
  {/snippet}
</Story>
