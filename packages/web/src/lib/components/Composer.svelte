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

<div class="composer">
  <textarea
    bind:value={text}
    {onkeydown}
    placeholder="Message… (Enter to send, Shift+Enter for newline)"
    rows="1"
  ></textarea>
  <Button.Root class="btn primary" onclick={send} disabled={!text.trim()}>Send</Button.Root>
</div>