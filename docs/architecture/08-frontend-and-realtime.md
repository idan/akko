# 08 — Frontend and Realtime

## Shape

- **Svelte 5 + bits-ui**, a single first-party web app. **Responsive; must work on
  mobile.**
- Talks to the backend over a **WebSocket** (events + commands) with HTTP for
  non-streaming operations (listing, config).
- Optionally uses **Jazz** for local-first realtime collaborative state (presence,
  typing, drafts, and a projected message view) — see doc 04 for why Jazz is a
  projection, never canonical.

## CQRS: commands in, events out

The frontend never mutates authoritative state. It follows the single-writer rule
(doc 04):

```
Browser ──command (prompt/steer/abort/setModel/fork/spawn/toggle-skill)──▶ Backend
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

Deferred but designed-for (additive, doc 02):

- **Presence** — who is in a session right now.
- **Typing indicators / cursors** — ephemeral Jazz state.
- **Attribution rendering** — show which participant sent each message (backed by the
  per-entry `actorId` side-field, doc 04); optionally the model is author-aware.
- **Concurrency feedback** — reflect the mailbox/queue state ("Bob is steering…"),
  driven by pi's `queue_update` events plus our attribution.

## Extension UI over the wire

If we load pi extensions that request user interaction (confirm/select/input), pi's
**RPC extension-UI sub-protocol** shows the exact request/response contract to bridge
those dialogs to the web UI. Even though we use the SDK (not RPC) in-process, the
same request/response envelopes are a good model for surfacing extension prompts to
the browser.
