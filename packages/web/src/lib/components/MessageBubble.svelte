<script lang="ts">
  /**
   * One chat bubble. Shared by the WS-reducer list and the Jazz read-model list so the
   * two render paths cannot drift — with utility classes, duplicated markup means
   * duplicated style strings, and this is the seam where that would bite.
   *
   * Test/query hooks are `data-*` attributes, deliberately *not* the styling classes:
   * utilities are free to change without breaking a test contract.
   */
  let { role, text = "", streaming = false, thinking = false }: {
    role: "user" | "assistant" | string;
    text?: string;
    streaming?: boolean;
    thinking?: boolean;
  } = $props();
</script>

<div class="flex {role === 'user' ? 'justify-end' : 'justify-start'}" data-role={role}>
  {#if thinking}
    <div
      class="inline-flex items-center gap-[5px] rounded-[14px] bg-assistant p-3.5"
      data-thinking
      role="status"
      aria-label="Assistant is thinking"
    >
      <span class="size-1.5 animate-thinking rounded-full bg-muted" data-dot></span>
      <span class="size-1.5 animate-thinking rounded-full bg-muted [animation-delay:0.2s]" data-dot></span>
      <span class="size-1.5 animate-thinking rounded-full bg-muted [animation-delay:0.4s]" data-dot></span>
    </div>
  {:else}
    <div
      class="max-w-[min(680px,85%)] whitespace-pre-wrap break-words rounded-[14px] px-3.5 py-2.5
             {role === 'user' ? 'bg-user' : 'bg-assistant'}"
    >
      {text}{#if streaming}<span class="animate-blink opacity-60" data-cursor>▋</span>{/if}
    </div>
  {/if}
</div>
