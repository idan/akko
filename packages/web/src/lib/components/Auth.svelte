<!--
  Auth.svelte — the passkey-only sign-in / sign-up gate (doc 16).

  Sign up collects a full name + email, then mints the first passkey (no password).
  Sign in triggers the passkey ceremony directly. On success we call `onAuthed()` so the
  parent can (re)load the session and mount the app.
-->
<script lang="ts">
  import { signInWithPasskey, signUpWithPasskey } from "../auth-client.ts";

  const { onAuthed }: { onAuthed: () => void } = $props();

  let mode = $state<"signin" | "signup">("signin");
  let name = $state("");
  let email = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  const emailValid = $derived(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()));
  const canSignUp = $derived(name.trim().length > 0 && emailValid && !busy);

  async function run(action: () => Promise<void>) {
    busy = true;
    error = null;
    try {
      await action();
      onAuthed();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid min-h-screen place-items-center p-4">
  <div class="flex w-full max-w-sm flex-col gap-3.5 rounded-xl border border-border bg-panel p-8">
    <h1 class="m-0 text-[1.6rem]">Akko</h1>
    <p class="mb-2 mt-0 text-sm text-muted">
      {mode === "signin" ? "Sign in with your passkey." : "Create your account with a passkey."}
    </p>

    {#if mode === "signup"}
      <label class="flex flex-col gap-1 text-xs text-muted">
        <span>Full name</span>
        <input
          class="rounded-lg border border-border bg-bg px-2.5 py-2 text-[0.95rem] text-text"
          type="text"
          bind:value={name}
          placeholder="Ada Lovelace"
          autocomplete="name"
          disabled={busy}
        />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        <span>Email</span>
        <input
          class="rounded-lg border border-border bg-bg px-2.5 py-2 text-[0.95rem] text-text"
          type="email"
          bind:value={email}
          placeholder="ada@example.com"
          autocomplete="email"
          disabled={busy}
        />
      </label>
      <button class="btn btn-primary mt-1" disabled={!canSignUp} onclick={() => run(() => signUpWithPasskey(name, email))}>
        {busy ? "Creating…" : "Create account & passkey"}
      </button>
      <p class="m-0 mt-0.5 text-center text-[0.82rem] text-muted">
        Already have an account?
        <button
          class="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-accent"
          onclick={() => { mode = "signin"; error = null; }}
          disabled={busy}
        >Sign in</button>
      </p>
    {:else}
      <button class="btn btn-primary mt-1" disabled={busy} onclick={() => run(signInWithPasskey)}>
        {busy ? "Authenticating…" : "Sign in with passkey"}
      </button>
      <p class="m-0 mt-0.5 text-center text-[0.82rem] text-muted">
        New here?
        <button
          class="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-accent"
          onclick={() => { mode = "signup"; error = null; }}
          disabled={busy}
        >Create an account</button>
      </p>
    {/if}

    {#if error}
      <p class="m-0 text-[0.85rem] text-danger" role="alert">{error}</p>
    {/if}
  </div>
</div>
