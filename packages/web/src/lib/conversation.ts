/**
 * Conversation reducer (doc 08) — pure, framework-agnostic, unit-tested.
 *
 * Folds the pi streaming events (delivered as `DomainEvent` of type `"pi"`) into a
 * simple message list the UI renders. Kept free of Svelte and of pi's exact types so
 * it is testable under `bun test` and decoupled from the pi type package.
 *
 * Slice scope: live streaming of an active session (assistant text as it streams, user
 * messages as pi starts them). Backlog fetch for rehydrated sessions and multi-client
 * attribution rendering are later.
 */

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
}

export interface ConversationState {
  messages: UiMessage[];
}

export const emptyConversation = (): ConversationState => ({ messages: [] });

/** The shape the reducer reads off a `DomainEvent` (kept loose to avoid pi type coupling). */
export interface WireEvent {
  type: string;
  sessionId: string;
  event?: unknown;
}

interface PiInner {
  type: string;
  message?: { role?: string; content?: unknown };
  assistantMessageEvent?: { type: string; delta?: string };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } => !!c && (c as { type?: string }).type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

let counter = 0;
const nextId = (): string => `m${counter++}`;

/** Fold one wire event into the conversation. Returns the same reference when unchanged. */
export function applyEvent(state: ConversationState, event: WireEvent): ConversationState {
  if (event.type !== "pi") return state;
  const inner = event.event as PiInner | undefined;
  if (!inner) return state;

  const messages = state.messages.slice();
  const last = messages[messages.length - 1];

  switch (inner.type) {
    case "message_start": {
      const role = inner.message?.role;
      if (role === "assistant") {
        messages.push({ id: nextId(), role: "assistant", text: "", streaming: true });
      } else if (role === "user") {
        messages.push({ id: nextId(), role: "user", text: textOf(inner.message?.content), streaming: false });
      } else {
        return state;
      }
      return { messages };
    }
    case "message_update": {
      const a = inner.assistantMessageEvent;
      if (a?.type === "text_delta" && a.delta && last && last.role === "assistant" && last.streaming) {
        messages[messages.length - 1] = { ...last, text: last.text + a.delta };
        return { messages };
      }
      return state;
    }
    case "message_end": {
      if (last && last.streaming) {
        const finalText = textOf(inner.message?.content) || last.text;
        messages[messages.length - 1] = { ...last, text: finalText, streaming: false };
        return { messages };
      }
      return state;
    }
    default:
      return state;
  }
}