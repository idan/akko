<script lang="ts">
  import { Button } from "bits-ui";

  let { onsend }: { onsend: (text: string) => void } = $props();

  let text = $state("");

  function send() {
    const t = text.trim();
    if (!t) return;
    onsend(t);
    text = "";
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div
  class="flex gap-2 border-t border-border bg-panel p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
>
  <textarea
    class="max-h-40 min-h-[42px] flex-1 resize-none rounded-xl border border-border bg-panel-2
           px-3 py-2.5 font-[inherit] text-text"
    bind:value={text}
    {onkeydown}
    placeholder="Message… (Enter to send, Shift+Enter for newline)"
    rows="1"
  ></textarea>
  <Button.Root class="btn btn-primary" onclick={send} disabled={!text.trim()}>Send</Button.Root>
</div>