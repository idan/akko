# 08 — Frontend and Realtime

## Shape

- **Styling is Tailwind v4** (`@tailwindcss/vite`), with the palette and the one-pane
  breakpoint declared as `@theme` tokens in `packages/web/src/app.css` — so `--color-panel`
  becomes `bg-panel` and the 720px pane split becomes the named `pane:` variant. bits-ui
  stays for headless behaviour; its primitives take a class string, and the shared button
  skin is a `@utility btn`. Components carry no scoped `<style>` blocks: styles live at
  the markup they apply to, which is what stops a class from being silently unstyled.
- **Svelte 5 + bits-ui**, a single first-party web app. **Responsive; must work on
  mobile.**
- Talks to the backend over a **WebSocket** (events + commands) with HTTP for
  non-streaming operations (listing, config).
- Uses **Jazz** for local-first realtime read state — the session list, projected
  messages, and the in-flight `activity` row (thinking/streaming), with presence and
  drafts to come. See doc 04 for why Jazz is a projection, never canonical.

> **Direction of travel (doc 15, "unify plan").** Jazz is becoming the **sole read
> model**, with the WebSocket reduced to commands and then retired in favour of HTTP
> commands. The end state is **HTTP for commands + Jazz for all reads**, which deletes
> the client-side event reducer, the subscription bookkeeping and the fan-out described
> below. The CQRS shape is unchanged — only the *read* transport moves. Sections below
> describe the WS read path that is being phased out; they remain accurate for the
> non-Jazz (`bun run dev`) configuration.

## CQRS: commands in, events out

The frontend never mutates authoritative state. It follows the single-writer rule
(doc 04):

```
Browser ──HTTP command (prompt/steer/abort/setModel/fork/spawn/toggle-skill)──▶ Backend
                                                                            │
                                                     mailbox → SessionRuntime → pi
                                                                            │
Browser ◀──events (streaming text, tool activity, lifecycle, queue)─────────┘
        ◀──projection updates (via Jazz or WS): committed messages, presence
```

- A user action becomes an **attributed `Command`** (carries `actorId`) posted to
  the session's mailbox.
- The backend `subscribe()`s once per live session and **fans out** the pi event
  stream to all connected clients for that session.
- Optimistic UI: the client may show a "pending" message immediately (ephemeral Jazz
  state); it is replaced when the backend commits the real entry.

## Multiple sessions and subagents

Because subagents are ordinary sessions in the `SessionRegistry` (doc 03), the
frontend renders them uniformly:

- A **session list / switcher** (from the DB session index, doc 04) — fast,
  workspace-scoped, ACL-filtered.
- A **live subagent view** (the web equivalent of `@tintinweb/pi-subagents`'
  FleetView): each running subagent is a session on the event bus, so we can show its
  status, live tool activity, token counts, and open its conversation — all with the
  same event-rendering code as top-level chats.

## Why we don't reuse the subagents packages' UI

`@tintinweb/pi-subagents` and `pi-subagents` render their fleet/conversation views as
**terminal (TUI) components** that no-op outside `ctx.mode === "tui"`. In a web
backend that UI is dead weight. We reuse their **engine patterns** (SDK spawning,
fuzzy model resolution, the agent-type `.md` format) and build the *view* natively in
Svelte against the same event stream. See doc 03 and doc 05.

## Presence and multiplayer affordances

Partly built, the rest additive (doc 02):

- **In-flight turn state** — **built**: an ephemeral `activity` row per session carries
  the sender's prompt, a "thinking" indicator and the streaming assistant text, so every
  observer (other tabs, devices, members) sees the same in-flight state with no fan-out.
- **Presence** — who is in a session right now. Deferred.
- **Typing indicators / cursors** — ephemeral Jazz state; would be the first sanctioned
  *client* write (non-authoritative, scoped to the writer's own principal). Deferred.
- **Attribution rendering** — show which participant sent each message (backed by the
  per-entry `actorId` side-field, doc 04, already projected as `authorId`); optionally
  the model is author-aware. Deferred.
- **Concurrency feedback** — reflect the mailbox/queue state ("Bob is steering…"),
  driven by pi's `queue_update` events plus our attribution. Deferred.

## Extension UI over the wire

If we load pi extensions that request user interaction (confirm/select/input), pi's
**RPC extension-UI sub-protocol** shows the exact request/response contract to bridge
those dialogs to the web UI. Even though we use the SDK (not RPC) in-process, the
same request/response envelopes are a good model for surfacing extension prompts to
the browser.
