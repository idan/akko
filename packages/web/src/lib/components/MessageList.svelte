<script lang="ts">
  import type { ConversationState } from "../conversation.ts";
  import MessageBubble from "./MessageBubble.svelte";

  let { conversation }: { conversation: ConversationState } = $props();

  let container: HTMLDivElement | undefined = $state();

  // Auto-scroll to the newest content as messages/stream update.
  $effect(() => {
    // touch reactive deps
    const _ = conversation.messages.length;
    const __ = conversation.messages.at(-1)?.text;
    const ___ = conversation.awaiting;
    void _;
    void __;
    void ___;
    if (container) container.scrollTop = container.scrollHeight;
  });
</script>

<div class="flex flex-1 flex-col gap-2.5 overflow-y-auto p-4" bind:this={container}>
  {#each conversation.messages as m (m.id)}
    <MessageBubble role={m.role} text={m.text} streaming={m.streaming} />
  {/each}
  {#if conversation.awaiting}
    <MessageBubble role="assistant" thinking />
  {/if}
</div>
