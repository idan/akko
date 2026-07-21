# 09 — Security and Isolation

## pi has no built-in sandbox — by design

pi runs with the permissions of the user account that starts it. Built-in tools
read/write files and run shell commands as ordinary local processes; extensions run
with the same permissions. pi's docs are explicit that a partial in-process sandbox
would be misleading, and that **real isolation must come from the OS / a
virtualization or container boundary.**

Consequences for Akko:

- **Project trust** is only an input-loading guard (it controls whether project-local
  settings/extensions/skills load). It is **not** a security boundary and does not
  restrict what tools can do once a session runs.
- Prompt injection from repository content, tool output, or model output is expected
  local-agent risk and cannot be reliably prevented at the pi layer.

So isolation is **Akko's seam**, not something pi provides.

## The isolation seam: decide the boundary, not the timing

The boundary is the **Workspace** (doc 02). A workspace declares
`isolation: "host" | "container"`. The `WorkspaceRuntime` resolves execution
(`cwd`, and later `bashOps` / `fsOps`) accordingly.

| Phase | Setting | Execution |
|-------|---------|-----------|
| Now (single-user / trusted) | `isolation: "host"` | per-workspace host dir (`~/workspaces/<id>`), zero overhead |
| Later (untrusted multiuser) | `isolation: "container"` | one of the patterns below |

The single non-negotiable now: **tool execution must never assume "the host
filesystem" directly** — it goes through the `WorkspaceRuntime`. As long as that
holds, switching host→container is a config flip, not a rearchitecture.

## Isolation patterns available (from pi's containerization guidance)

| Pattern | What is isolated | Notes |
|---------|------------------|-------|
| **Whole process per workspace** (Docker) | The entire pi/agent process for that workspace | Strongest, simplest to reason about. Provider keys enter the container unless an inference-routing gateway keeps them out. Changes host-routing to "route to the workspace's container" (ties into `HostResolver`, doc 03). |
| **Tool-routing extension** (Gondolin-style micro-VM) | Built-in tools + `!` commands routed into a per-workspace VM; one backend process | Overrides `read/write/edit/bash/grep/find/ls`. Keeps a single backend but sandboxes fs/exec. |
| **Policy-controlled sandbox** (OpenShell) | Whole process in a managed sandbox | Filesystem/process/network/credential/inference controls; can keep raw API keys outside the sandbox via inference routing. |

Because the seam (`WorkspaceRuntime` + `HostResolver`) is the same regardless, the
choice is deferrable. Whole-process-per-workspace pairs naturally with the future
horizontal-scale story (each workspace's live sessions live on its own host/node).

## Credentials

- `CredentialProvider.for(workspace)` yields the workspace's `AuthStorage` /
  `ModelRegistry` (doc 02). Single shared instance today; per-workspace or vault-
  backed later.
- pi supports runtime API-key overrides (`authStorage.setRuntimeApiKey`, not
  persisted) and `models.json` value resolution via shell commands / env
  interpolation — useful for injecting short-lived, per-request credentials without
  writing them to disk.
- Multiuser guidance: pass the **minimum** credentials a workspace needs; prefer
  short-lived credentials; for `container` isolation, prefer inference-routing so raw
  keys never enter the sandbox.

## Authorization vs. isolation

These are two different layers and both are required:

- **`authorize()`** (doc 02) controls *who may issue which command* against a
  session/workspace. It is an application-level policy gate.
- **Isolation** controls *what damage tool execution can do* to the host/other
  tenants. It is an OS/container boundary.

Neither substitutes for the other.
