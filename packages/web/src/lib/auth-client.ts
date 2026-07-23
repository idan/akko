/**
 * Better Auth browser client (doc 16) — passkeys only.
 *
 * Same-origin: the app is served by Vite which proxies `/api` (and thus `/api/auth`) to
 * the gateway, so the session cookie is set + sent automatically. No baseURL needed.
 *
 * Signup is passkey-first: we pass the collected `{ name, email }` as the registration
 * `context`; the backend's `resolveUser` finds-or-creates the user and the ceremony
 * mints the first passkey + a session in one step.
 */
import { createAuthClient } from "better-auth/svelte";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

export interface AuthedUser {
  id: string;
  name: string;
  email: string;
}

/** Current session's user, or `null` when signed out. */
export async function currentUser(): Promise<AuthedUser | null> {
  const res = await authClient.getSession();
  const user = res.data?.user;
  return user ? { id: user.id, name: user.name, email: user.email } : null;
}

/**
 * Passkey-first signup: create (or reuse) the user and register a passkey. The backend
 * sets the session cookie during registration (`afterVerification`), so this ends
 * authenticated with a single WebAuthn prompt — no follow-up sign-in needed.
 */
export async function signUpWithPasskey(name: string, email: string): Promise<void> {
  const res = await authClient.passkey.addPasskey({
    context: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase() }),
  });
  if (res?.error) throw new Error(res.error.message ?? "passkey registration failed");
}

/** Sign in with an existing passkey. */
export async function signInWithPasskey(): Promise<void> {
  const res = await authClient.signIn.passkey();
  if (res?.error) throw new Error(res.error.message ?? "passkey sign-in failed");
}

export async function signOut(): Promise<void> {
  await authClient.signOut();
}
