# 16 — Authentication and Authorization

This doc records the concrete auth design and its v1 implementation. The *why* behind
identity-on-every-record lives in [02 — Tenancy and Identity](./02-tenancy-and-identity.md);
this doc is the *how*: who issues identity, how the edge proves it, and how role-based
authorization is enforced.

## The shape

```
Better Auth (in-process with the gateway; passkey + jwt plugins)
   user/session/account/passkey/jwks tables → canonical SQLite (never Jazz)
        │  issues an HttpOnly session cookie  (+ a JWKS endpoint for later)
        ▼
gateway edge  ── validates the cookie on every HTTP request AND at WS upgrade ──▶ principalId
        │
        ▼
MembershipStore  (workspaceId, principalId, role)  ──▶ role
        │
        ▼
authorize(principal, action, resource)  — RoleBasedPolicy in the mailbox (doc 02/03)
```

One identity issuer (Better Auth), verified at one choke point (the gateway), feeding
the single authorization gate (`authorize()`). Nothing about record shape or call
signatures changes — this is the "swap the impl behind the seam" half of doc 02.

## Decisions

- **Better Auth, in-process.** It runs inside the `@akko/server` gateway process, not as
  a separate service. Its `handler` is mounted at `/api/auth/*`. No network hop to
  validate a session.
- **Better Auth's tables live in canonical SQLite** (`~/.akko/akko.db`, same file as the
  session index and conversation store). This upholds the doc 04 discipline: identity is
  canonical data, and Jazz never owns it. We explicitly **reject** the reverse
  integration (`jazzAdapter`, storing Better Auth tables *in* Jazz).
- **Passkeys only.** No passwords. The passkey (WebAuthn) plugin is the only
  authentication mechanism; the jwt plugin is enabled so a JWKS endpoint + signed JWTs
  are ready for the deferred Jazz read-ACL path (below), even though nothing consumes
  them yet.
- **Signup = full name + email, then a passkey.** We use the passkey plugin's
  passkey-first registration (`registration.requireSession: false` + a `resolveUser`
  hook). The client sends `{ name, email }` as the registration `context`; `resolveUser`
  finds-or-creates the Better Auth user and returns it; the ceremony mints the first
  passkey and a session in one step. No email verification and no password for v1.
- **`PrincipalId` == Better Auth `user.id`.** We configure Better Auth's id generator to
  mint our prefixed ids (`prn_<nanoid>`), so a Better Auth user *is* an Akko `Principal`
  with no mapping table. `displayName` = the user's `name`.
- **Cookie at the WS edge.** Because Better Auth is in-process and same-origin, the WS
  upgrade request carries the session cookie. The gateway validates it at `upgrade()`
  time and derives `principalId` server-side — retiring the old, trusted
  `?principal=<id>` query param and `x-akko-principal` header entirely.

## Membership and roles

`Membership { workspaceId, principalId, role: "owner" | "editor" | "viewer" }` (doc 02)
gets a real store for the first time: `MembershipStore` (`@akko/runtime`), with an
in-memory impl (tests) and a `SqliteMembershipStore` (durable). On user creation a
Better Auth `databaseHooks.user.create.after` hook grants the new user `owner` of the
default dev workspace, so a freshly-registered user can immediately use it. (Per-user
*personal* workspace provisioning is a follow-up; see below.)

`RoleBasedPolicy` (`@akko/core`, replacing `AllowAllPolicy`) maps role → action:

| Role | session commands (prompt/steer/…) | session.read | session.create | workspace.configure / manageMembers |
|------|-----------------------------------|--------------|----------------|-------------------------------------|
| owner | ✅ | ✅ | ✅ | ✅ |
| editor | ✅ | ✅ | ✅ | ❌ |
| viewer | ❌ | ✅ | ❌ | ❌ |
| (no membership) | ❌ | ❌ | ❌ | ❌ |

The registry resolves the actor's role from the `MembershipStore` and passes it in the
`AuthorizationContext`; the mailbox consults the policy before applying every command
(doc 03). Workspace-scoped HTTP ops (list/create/history) additionally check membership
at the gateway and return `401` (unauthenticated) / `403` (not a member).

## What is deferred (designed, not built)

## Jazz read-ACL (implemented)

The Jazz read model now enforces the same workspace boundary as the command path, keyed
on a verified JWT claim (doc 14):

```
Better Auth jwt plugin  ──JWT { sub, workspaceId }──▶  browser
   (definePayload adds the reader's workspaceId claim)         │ jwtToken
                                                               ▼
   Jazz sync server  ──verifies JWT via Better Auth's JWKS (--jwks-url)──▶ Session { claims }
                                                               │
   messages row policy: allowRead.where({ workspaceId: session.workspaceId })
```

- **Claim**: the jwt plugin's `definePayload` stamps `workspaceId` (the reader's first
  membership) onto every JWT. Single-workspace v1; a multi-workspace claim (list + IN
  match) is the extension.
- **Verification**: the standalone `jazz-tools server` runs with
  `--jwks-url http://localhost:8787/api/auth/jwks` and **without**
  `--allow-local-first-auth`, so it verifies Better Auth's EdDSA JWTs and rejects the
  anonymous keypair path. The projected `messages` table carries a `workspaceId` column;
  the row policy (`definePermissions`) allows a read only when it matches the JWT claim,
  and `allowInsert.never()` keeps clients read-only (the backend projector writes with a
  privileged secret that bypasses policies).
- **Frontend**: the browser fetches a JWT from `/api/auth/token` and passes it as
  `createJazzClient({ jwtToken })` (replacing the anonymous `LocalFirstAuth` secret).

## What is deferred (designed, not built)

- **Account recovery.** Passkey-only means losing every authenticator = lockout. Fine for
  an early personal system (re-seed from the backend); a recovery path (a second factor
  or admin re-issue) is a conscious follow-up.
- **Per-user personal workspaces.** v1 grants new users `owner` of the shared dev
  workspace. Provisioning a dedicated workspace (storage root + registration) per user is
  the multi-tenant follow-up.
- **RP-ID / origin for prod.** Passkeys are bound to a domain. Dev uses `localhost`; the
  production relying-party id + origin are config to set at deploy.

## Loose ends (implementation notes)

Things that work but are worth revisiting:

- **Signup is a single WebAuthn prompt.** Better Auth's passkey `verify-registration`
  mints the credential but issues no session, so the passkey plugin's `afterVerification`
  hook creates a session and sets the cookie during registration (only when the registrant
  has none yet). The one create-credential ceremony ends authenticated — no follow-up
  sign-in.
- **CORS is not configured on the gateway.** The old permissive `access-control-allow-*`
  headers were dropped: dev is same-origin (Vite proxies `/api` + `/ws`), and cookies +
  `allow-origin: *` are mutually exclusive anyway. A cross-origin deployment (web app on a
  different origin than the gateway) will need explicit CORS with credentials + a specific
  allowed origin.
- **Two SQLite handles on one file.** Better Auth opens its own `bun:sqlite` handle on the
  same `akko.db` (WAL) as the runtime adapter. Fine in one process; if the auth surface
  ever moves out-of-process, revisit.
- **Vite's WS proxy is broken under Bun.** Vite 8's dev proxy can't relay WebSocket
  upgrades when Vite runs under Bun (`socket.destroySoon is not a function`) — the upgrade
  reaches the gateway but the 101/frames never return, so the WS is stuck "offline." The
  browser therefore connects the WS **straight to the gateway** in dev (`VITE_WS_URL`,
  default `ws://localhost:8787/ws`); cross-port is same-site so the session cookie is
  still sent. HTTP (`/api`) still goes through the Vite proxy, which works. Prod is
  same-origin, so `/ws` is used directly. Revisit if a future Vite/Bun fixes the proxy.
- **Test gaps.** The membership store and role policy have unit tests, the gateway
  HTTP/WS paths use a test auth stub, and the Jazz projector round-trips a workspace-
  stamped row; there is no committed test for the `/api/models` route, the 403 (non-
  member) branches, or a real Better Auth session round-trip (the passkey ceremony needs
  a browser).
- **Jazz read-ACL needs live verification.** The claim + policy + `--jwks-url` wiring is
  proven headlessly (`jazz-read-acl.test.ts`: a `workspaceId`-claim JWT reads only its
  own workspace's rows), but the browser path (JWT via `/api/auth/token` → sync server
  verify → QuerySubscription) still wants a real end-to-end eyeball. Two gotchas were
  found and fixed: **(a)** Jazz reads claims from the JWT's nested `claims` object, so
  the policy uses `session["claims.workspaceId"]` and Better Auth's `definePayload`
  returns `{ claims: { workspaceId } }`; **(b)** the browser Jazz client logs a benign
  `CatalogueWriteDenied` (it isn't admin, so it can't republish the already-deployed
  schema — reads still work). Remaining watch items: JWT **audience** (tune Better Auth's
  jwt `audience` if the sync server rejects) and **token refresh** on expiry
  (`JazzClient.updateAuthToken(...)`).

## Where it lives

| Concern | Module |
|---------|--------|
| Better Auth instance (passkey + jwt, resolveUser, generateId, membership hook) | `packages/server/src/auth.ts` |
| Mount `/api/auth/*`, cookie→principal on HTTP + WS, membership gate | `packages/server/src/gateway.ts` |
| Boot: migrate auth tables, seed dev workspace + membership store | `packages/server/src/main.ts` |
| Membership store (interface + in-memory + SQLite) | `packages/runtime/src/membership-store.ts` |
| `RoleBasedPolicy` (+ `AllowAllPolicy`) | `packages/core/src/authz.ts` |
| Role threaded into the authz context | `packages/runtime/src/session-registry.ts` |
| Auth client + login/signup UI | `packages/web/src/lib/auth-client.ts`, `packages/web/src/lib/components/Auth.svelte` |
| Jazz read-ACL: `workspaceId` column + claim-based row policy | `packages/schema/src/index.ts` |
| JWT `workspaceId` claim (`definePayload`) | `packages/server/src/auth.ts` |
| Projector stamps `workspaceId` onto rows | `packages/server/src/jazz-projector.ts` |
| Frontend Jazz client uses the Better Auth JWT | `packages/web/src/App.svelte`, `packages/web/src/lib/auth-client.ts` |
| Sync server verifies JWTs (`--jwks-url`, no local-first) | `package.json` `dev:sync` |
