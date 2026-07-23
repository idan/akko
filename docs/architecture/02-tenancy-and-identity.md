# 02 — Tenancy and Identity

Multiuser is a **first-class design constraint**, even before it is implemented. The
reason: identity, attribution, and isolation touch the shape of *every record and
every call path*. Retrofitting them later is one of the most painful rewrites there
is. So we split the problem into **invariants to bake in now** and **seams to defer**.

## The rule

> If a change would alter a stored record's shape or a call's signature, do it now.
> If it only swaps an implementation, hide it behind an interface and stub it.

## Bake in now (structurally hard to add later)

| Invariant | Why it cannot be deferred |
|-----------|---------------------------|
| **Identity on every record & command** — every session, entry, and mutating action carries a `principalId` (author) + `workspaceId`. No implicit "the user". | Retrofitting authorship into a conversation store is a data migration plus a rewrite of every read path. Multiplayer *is* attribution. |
| **Workspace = the tenancy boundary** owning filesystem/cwd, session-storage root, auth + model registry, resource config (skills/extensions), and memory. | This is the unit we later isolate, share, route, and bill. If sessions aren't owned by a workspace from day 1, ACLs and isolation have nothing to hang on. |
| **A single authorization choke point** — `authorize(principal, action, resource)` that every command passes through. | Threading authz through N handlers after the fact always misses one. Add the gate now; it returns `ALLOW` for the single user. |
| **Commands are attributed, logged records** — `{ id, actor, sessionId, verb, args, ts }`, not anonymous method calls. | This log is the substrate for multiplayer sync, audit, and rehydration. Painful to reconstruct later. |
| **Durable vs. liveness split** — content in the ConversationStore, index/ACL/attribution in our DB, the in-memory `AgentSession` a rebuildable cache. | This one decision is what enables failover, horizontal scale, and multiplayer without rearchitecture (doc 03). |
| **Globally unique IDs** for workspace / principal / session / entry. | Single-user shortcuts (path-derived ids, a "default" user) leak everywhere. |

## Defer behind a seam (design the interface, stub the impl)

| Concern | Seam | Trivial impl now | Real impl later |
|---------|------|------------------|-----------------|
| Filesystem / exec isolation | `WorkspaceRuntime → { cwd, bashOps?, fsOps? }` | host cwd `~/workspaces/<id>` | container / micro-VM per workspace (doc 09) |
| Which node hosts a live session | `HostResolver.resolve(sessionId) → node` | constant (this node) | affinity router / consistent hashing |
| Per-tenant credentials & entitled models | `CredentialProvider.for(workspace) → { AuthStorage, ModelRegistry }` | one shared instance | per-workspace `auth.json`/`models.json` or a vault |
| Authentication (who is this caller?) | Better Auth at the gateway edge; `MembershipStore` → role | passkey login → cookie → principal; single dev workspace ([doc 16](./16-auth.md)) | JWT/JWKS → Jazz read-ACL; per-user workspaces |
| Realtime transport | `EventBus` (pub/sub by sessionId) | in-process emitter | Redis / NATS |
| Presence / typing / cursors | additive projection state | omit | add (doc 08) |

## The domain model (minimal, multiuser-shaped)

```
Principal   { id, kind: "user" | "service", displayName }
Workspace   { id, name, storageRoot, isolation: "host" | "container" }
Membership  { workspaceId, principalId, role: "owner" | "editor" | "viewer" }
SessionRef  { id, workspaceId, ownerId, kind: "conversation" | "subagent",
              parentSessionId?, title, hostNode, updatedAt }   // in OUR DB
Command     { id, sessionId, actorId, verb, args, ts }         // attributed log
```

- **Single-user** = one workspace with one owner member.
- **Multiplayer** = one workspace, many members on the same session.
- **Multi-tenant** = many workspaces.
- A **subagent** is just a `SessionRef` with `kind: "subagent"` and a
  `parentSessionId`. Same registry, same event stream, ACL inherited from the
  parent (doc 03/08).

## ID format

Ids are **globally unique** (never path-derived or implicit). Akko mints them as
**prefixed, URL-safe nanoids** (`@akko/runtime` `ids.ts`): a short stable type prefix,
an underscore, then a full-entropy `nanoid()` (21 chars, ~126 bits, UUIDv4-comparable)
— e.g. `ses_V1StGXR8Z5jdHi6BmyT`. The prefix makes ids self-describing in URLs, logs,
and stored data, and complements the compile-time branding (`domain.ts`) with a
runtime signal of "wrong id type".

| Entity | Prefix | Minted by |
|--------|--------|-----------|
| Principal | `prn_` | Akko |
| Workspace | `wsp_` | Akko |
| Session | `ses_` | Akko |
| Command | `cmd_` | Akko |
| Node | `nod_` | Akko |
| Entry | — (pi's 8-char tree id) | **pi** (Akko stores/uses pi's directly) |

Prefixes are **stable** — they may appear in URLs and persisted rows, so they are not
changed once shipped. `EntryId` is pi's own session-tree id; Akko does not mint these
in normal operation.

## How a Workspace maps onto pi

A `WorkspaceRuntime` binds pi's per-call parameters to a tenant:

```
workspace →
  cwd:             <storageRoot>/tree              (or a container mount, doc 09)
  sessionManager:  SessionManager rooted at <storageRoot>/sessions
  authStorage:     AuthStorage.create(<...>/auth.json)      // via CredentialProvider
  modelRegistry:   ModelRegistry.create(auth, <...>/models.json)
  resourceLoader:  DefaultResourceLoader({ cwd, agentDir })  // workspace skills/exts
  settingsManager: SettingsManager.create(cwd, agentDir)
```

`createAgentSession(...)` simply consumes that bundle. Model routing becomes
per-tenant automatically, because the router reads
`modelRegistry.getAvailable()` from *this workspace's* registry — i.e., the
caller's entitlements, not a global list (doc 05).

## Authorization

`authorize(principal, action, resource)` is the single gate. Every mutating command
(prompt / steer / abort / setModel / fork / spawn subagent / toggle skill) passes
through it, and it is also where **concurrency policy** is enforced (doc 03). The
role-based implementation and how identity reaches this gate are in
[doc 16](./16-auth.md). Roles: `owner` > `editor` > `viewer`.
