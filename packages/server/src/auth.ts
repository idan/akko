/**
 * Better Auth, in-process (doc 16).
 *
 * The single identity issuer for Akko. Runs inside the gateway process; its tables
 * (user/session/account/passkey/jwks) live in the **canonical SQLite** file — never in
 * Jazz. Authentication is **passkeys only**: no passwords. Signup collects a full name +
 * email and then mints the first passkey via the plugin's passkey-first registration
 * (`requireSession: false` + `resolveUser`). The jwt plugin exposes a JWKS endpoint and
 * signs JWTs for the *deferred* Jazz read-ACL path (doc 14); nothing consumes them yet.
 *
 * A Better Auth `user.id` **is** an Akko `PrincipalId`: we generate `prn_<nanoid>` ids so
 * no mapping table is needed. On user creation we grant `owner` of the default workspace
 * via `onUserCreated`, so a freshly-registered principal can immediately use it.
 */
import type { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins/jwt";
import { passkey } from "@better-auth/passkey";
import { setSessionCookie } from "better-auth/cookies";
import { getSessionFromCtx } from "better-auth/api";
import type { PrincipalId } from "@akko/core";
import { newPrincipalId } from "@akko/runtime";
import type { MembershipStore } from "@akko/runtime";

export interface AkkoAuthDeps {
  /** A `bun:sqlite` Database handle (Better Auth manages its own tables on it). */
  db: Database;
  /** Public origin of the auth endpoints, e.g. `http://localhost:8787`. */
  baseURL: string;
  /** Signing secret for sessions/JWTs. */
  secret: string;
  /** WebAuthn relying-party id — `localhost` in dev, your domain in prod. */
  rpID: string;
  /** Human-readable relying-party name shown in the passkey prompt. */
  rpName: string;
  /** Browser origin(s) where the WebAuthn ceremony runs (the web app), e.g. `http://localhost:5173`. */
  origin: string | string[];
  /** Origins allowed to call the auth endpoints (CSRF). */
  trustedOrigins: string[];
  /** Called after a new user row is created — used to grant a default workspace membership. */
  onUserCreated: (user: { id: PrincipalId; name: string; email: string }) => void;
  /** Source of principal→workspace roles — read to stamp the JWT's `workspaceId` claim (doc 16). */
  memberships: MembershipStore;
}

export interface AuthenticatedPrincipal {
  principalId: PrincipalId;
  displayName: string;
  email: string;
}

/** The auth surface Akko consumes. Explicitly typed so no transitive plugin types leak. */
export interface AkkoAuth {
  /** Handle a Better Auth route (`/api/auth/*`). */
  handler: (req: Request) => Promise<Response>;
  /** Resolve the authenticated principal from request headers (the session cookie). */
  getPrincipal: (headers: Headers) => Promise<AuthenticatedPrincipal | null>;
  /** Better Auth options — used to run table migrations at boot. */
  options: BetterAuthOptions;
}

export function createAkkoAuth(deps: AkkoAuthDeps): AkkoAuth {
  const auth = betterAuth({
    database: deps.db,
    baseURL: deps.baseURL,
    secret: deps.secret,
    trustedOrigins: deps.trustedOrigins,
    // Passwordless: email/password auth is left disabled. Passkeys are the only method.
    advanced: {
      database: {
        // A Better Auth user IS an Akko Principal — mint our prefixed ids for the user
        // model; other internal models get plain uuids.
        generateId: ({ model }: { model: string }) =>
          model === "user" ? (newPrincipalId() as string) : crypto.randomUUID(),
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; name: string; email: string }) => {
            deps.onUserCreated({
              id: user.id as PrincipalId,
              name: user.name,
              email: user.email,
            });
          },
        },
      },
    },
    plugins: [
      passkey({
        rpID: deps.rpID,
        rpName: deps.rpName,
        origin: deps.origin,
        registration: {
          // Passkey-first signup: no existing session required. The client sends
          // `{ name, email }` as the registration `context`; we find-or-create the user.
          requireSession: false,
          resolveUser: async ({ ctx, context }) => {
            let parsed: { name?: string; email?: string } = {};
            try {
              parsed = context ? JSON.parse(context) : {};
            } catch {
              throw ctx.error("BAD_REQUEST", { message: "invalid registration context" });
            }
            const email = String(parsed.email ?? "").trim().toLowerCase();
            const name = String(parsed.name ?? "").trim();
            if (!email || !name) {
              throw ctx.error("BAD_REQUEST", { message: "name and email are required" });
            }
            const existing = await ctx.context.internalAdapter.findUserByEmail(email);
            if (existing?.user) {
              return { id: existing.user.id, name: existing.user.name, displayName: existing.user.name };
            }
            const created = await ctx.context.internalAdapter.createUser({
              email,
              name,
              emailVerified: false,
            });
            return { id: created.id, name: created.name, displayName: created.name };
          },
          // Single-prompt signup (doc 16): Better Auth's `verify-registration` mints the
          // credential but issues no session. If the registrant has no session yet, we
          // create one and set the cookie here, so the *registration* ceremony itself
          // lands them authenticated — no second passkey prompt.
          afterVerification: async ({ ctx, user }) => {
            const existing = await getSessionFromCtx(ctx).catch(() => null);
            if (existing?.session) return;
            const session = await ctx.context.internalAdapter.createSession(user.id);
            if (!session) return;
            const fullUser = await ctx.context.internalAdapter.findUserById(user.id);
            if (!fullUser) return;
            await setSessionCookie(ctx, { session, user: fullUser });
          },
        },
      }),
      jwt({
        jwt: {
          // Explicit rather than inherited. Better Auth defaults to 15m; the browser
          // renews a minute before expiry and on wake (see lib/jazz-token.ts), so a short
          // life is cheap and keeps a leaked read token from being useful for long.
          expirationTime: "15m",
          // Stamp the reader's workspace onto the JWT so the Jazz read-ACL can filter
          // projected rows by verified claim (doc 16/14). Jazz reads claims from the
          // JWT's nested `claims` object, so we return `{ claims: {...} }` (Better Auth
          // spreads this into the payload). Single-workspace v1: the first membership.
          definePayload: ({ user }: { user: { id: string } }) => {
            const ms = deps.memberships.listForPrincipal(user.id as PrincipalId);
            return { claims: { workspaceId: ms[0]?.workspaceId ?? "" } };
          },
        },
      }),
    ],
  });

  /**
   * Resolve the authenticated principal from a request's headers (the Better Auth
   * session cookie). Returns `null` when there is no valid session. Used by the gateway
   * on every HTTP request and at the WS upgrade.
   */
  async function getPrincipal(headers: Headers): Promise<AuthenticatedPrincipal | null> {
    const session = await auth.api.getSession({ headers });
    if (!session?.user) return null;
    return {
      principalId: session.user.id as PrincipalId,
      displayName: session.user.name,
      email: session.user.email,
    };
  }

  return { handler: auth.handler, getPrincipal, options: auth.options as BetterAuthOptions };
}
