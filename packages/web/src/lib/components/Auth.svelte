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

<div class="auth">
  <div class="card">
    <h1>Akko</h1>
    <p class="tagline">
      {mode === "signin" ? "Sign in with your passkey." : "Create your account with a passkey."}
    </p>

    {#if mode === "signup"}
      <label>
        <span>Full name</span>
        <input type="text" bind:value={name} placeholder="Ada Lovelace" autocomplete="name" disabled={busy} />
      </label>
      <label>
        <span>Email</span>
        <input type="email" bind:value={email} placeholder="ada@example.com" autocomplete="email" disabled={busy} />
      </label>
      <button class="primary" disabled={!canSignUp} onclick={() => run(() => signUpWithPasskey(name, email))}>
        {busy ? "Creating…" : "Create account & passkey"}
      </button>
      <p class="switch">
        Already have an account?
        <button class="link" onclick={() => { mode = "signin"; error = null; }} disabled={busy}>Sign in</button>
      </p>
    {:else}
      <button class="primary" disabled={busy} onclick={() => run(signInWithPasskey)}>
        {busy ? "Authenticating…" : "Sign in with passkey"}
      </button>
      <p class="switch">
        New here?
        <button class="link" onclick={() => { mode = "signup"; error = null; }} disabled={busy}>Create an account</button>
      </p>
    {/if}

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  </div>
</div>

<style>
  .auth {
    display: grid;
    place-items: center;
    min-height: 100vh;
    padding: 1rem;
  }
  .card {
    width: 100%;
    max-width: 22rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 2rem;
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 12px;
    background: var(--surface, #161616);
  }
  h1 {
    margin: 0;
    font-size: 1.6rem;
  }
  .tagline {
    margin: 0 0 0.5rem;
    color: var(--muted, #9a9a9a);
    font-size: 0.9rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.8rem;
    color: var(--muted, #9a9a9a);
  }
  input {
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 8px;
    background: var(--bg, #0e0e0e);
    color: inherit;
    font-size: 0.95rem;
  }
  button.primary {
    margin-top: 0.4rem;
    padding: 0.6rem;
    border: none;
    border-radius: 8px;
    background: var(--accent, #4f7cff);
    color: white;
    font-weight: 600;
    cursor: pointer;
  }
  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .switch {
    margin: 0.2rem 0 0;
    font-size: 0.82rem;
    color: var(--muted, #9a9a9a);
    text-align: center;
  }
  button.link {
    background: none;
    border: none;
    color: var(--accent, #4f7cff);
    cursor: pointer;
    padding: 0;
    font: inherit;
  }
  .error {
    margin: 0;
    color: #ff6b6b;
    font-size: 0.85rem;
  }
</style>
