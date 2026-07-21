<script lang="ts">
  import { CoState } from "jazz-tools/svelte";
  import { Conversation } from "@akko/schema";

  let { jazzId }: { jazzId: string } = $props();

  // Reactive load of the projected conversation CoValue (doc 14).
  const convo = new CoState(Conversation, () => jazzId, {
    resolve: { messages: { $each: true } },
  });

  type UiMsg = { $jazz: { id: string }; role: string; text: string };
  const messages = $derived(
    ((convo.current as { messages?: Array<UiMsg | null> } | null | undefined)?.messages ?? []) as Array<UiMsg | null>,
  );
</script>

<div class="messages">
  <p class="jazz-note">Projected read model (Jazz CoValue {jazzId.slice(0, 10)}…)</p>
  {#each messages as m (m?.$jazz.id)}
    {#if m}
      <div class="msg {m.role}">
        <div class="bubble">{m.text}</div>
      </div>
    {/if}
  {:else}
    <p class="empty">No projected messages yet.</p>
  {/each}
</div>