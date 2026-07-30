<script lang="ts">
  import { Button } from "bits-ui";
  import type { AkkoClient } from "../client.svelte.ts";

  let { client, onclose }: { client: AkkoClient; onclose: () => void } = $props();

  let prompt = $state<string | null>(null);
  let loadingPrompt = $state(false);

  // Load on mount and whenever the panel is shown; skills change rarely, so on-demand is
  // right — this is not something to poll.
  $effect(() => {
    void client.loadSkills();
  });

  const impact = $derived(client.skillImpact);
  /** Cost per skill, largest first: the budget view is for finding what to trim. */
  const costs = $derived(
    new Map((impact?.perSkill ?? []).map((p) => [p.name, p.tokens] as const)),
  );
  const ranked = $derived(
    [...client.skills].sort((a, b) => (costs.get(b.name) ?? 0) - (costs.get(a.name) ?? 0)),
  );

  async function togglePrompt() {
    if (prompt !== null) {
      prompt = null;
      return;
    }
    loadingPrompt = true;
    prompt = await client.loadSystemPrompt();
    loadingPrompt = false;
  }
</script>

<div class="flex h-[100dvh] min-w-0 flex-1 flex-col">
  <header class="flex items-center gap-2.5 border-b border-border bg-panel px-4 py-3">
    <h2 class="m-0 text-base">Skills</h2>
    {#if impact}
      <!-- The headline number: what skills cost on *every* turn, which is otherwise
           completely invisible (doc 06). -->
      <span class="rounded-lg bg-panel-2 px-2 py-1 text-xs text-muted" data-budget>
        {impact.totalTokens} tokens / turn
      </span>
    {/if}
    <button class="ml-auto border-0 bg-transparent text-xl text-text" onclick={onclose} aria-label="Close skills">×</button>
  </header>

  <div class="flex-1 overflow-y-auto p-4">
    {#if client.staleSessions.length > 0}
      <p class="mb-3 rounded-lg border border-border bg-panel px-3 py-2 text-xs text-muted" role="status">
        {client.staleSessions.length} running session(s) started before the latest change and
        keep their old skill set until they go idle.
      </p>
    {/if}

    {#if client.error}
      <p class="mb-3 rounded-lg border border-border px-3 py-2 text-xs text-danger" role="alert">
        {client.error}
      </p>
    {/if}

    {#if ranked.length === 0}
      <p class="text-muted">No skills discovered for this workspace.</p>
    {:else}
      <ul class="m-0 flex list-none flex-col gap-2 p-0">
        {#each ranked as s (s.name)}
          <li
            class="flex items-start gap-3 rounded-xl border border-border bg-panel p-3"
            class:opacity-60={s.hiddenFromPrompt}
            data-skill={s.name}
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate font-medium">{s.name}</span>
                <span class="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">
                  {s.source}
                </span>
              </div>
              <p class="m-0 mt-1 text-sm text-muted">{s.description}</p>
            </div>
            <div class="flex shrink-0 flex-col items-end gap-1">
              <span class="font-mono text-xs text-muted" data-cost>
                {s.hiddenFromPrompt ? "0" : (costs.get(s.name) ?? 0)} tok
              </span>
              <!-- Only workspace-owned skills are ours to change; a disk skill is the
                   user's file and the server refuses to rewrite it. -->
              <Button.Root
                class="btn h-7 px-2 text-xs"
                onclick={() => client.setSkillHidden(s.name, !s.hiddenFromPrompt)}
              >
                {s.hiddenFromPrompt ? "Show in prompt" : "Hide from prompt"}
              </Button.Root>
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="mt-4">
      <Button.Root class="btn" onclick={togglePrompt}>
        {prompt !== null ? "Hide" : "Show"} full system prompt
      </Button.Root>
      {#if loadingPrompt}
        <p class="mt-2 text-xs text-muted">Building…</p>
      {:else if prompt !== null}
        <pre
          class="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl border border-border
                 bg-panel-2 p-3 font-mono text-xs text-muted">{prompt}</pre>
      {/if}
    </div>

    {#if impact?.injectedBlock}
      <details class="mt-3">
        <summary class="cursor-pointer text-sm text-muted">Injected skills block</summary>
        <pre
          class="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-border
                 bg-panel-2 p-3 font-mono text-xs text-muted">{impact.injectedBlock}</pre>
      </details>
    {/if}
  </div>
</div>
