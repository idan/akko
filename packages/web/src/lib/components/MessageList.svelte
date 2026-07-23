<script lang="ts">
  import type { ConversationState } from "../conversation.ts";

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

<div class="messages" bind:this={container}>
  {#each conversation.messages as m (m.id)}
    <div class="msg {m.role}">
      <div class="bubble">
        {m.text}{#if m.streaming}<span class="cursor">▋</span>{/if}
      </div>
    </div>
  {/each}
  {#if conversation.awaiting}
    <div class="msg assistant">
      <div class="bubble thinking" role="status" aria-label="Assistant is thinking">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>
  {/if}
</div>