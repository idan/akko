import { render, screen } from "@testing-library/svelte";
import { describe, expect, test } from "vitest";
import MessageList from "./MessageList.svelte";
import type { ConversationState } from "../conversation.ts";

const conv = (messages: ConversationState["messages"]): ConversationState => ({ messages });

describe("MessageList", () => {
  test("renders user and assistant bubbles with role classes", () => {
    const { container } = render(MessageList, {
      conversation: conv([
        { id: "m1", role: "user", text: "hello", streaming: false },
        { id: "m2", role: "assistant", text: "hi there", streaming: false },
      ]),
    });

    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("hi there")).toBeInTheDocument();
    expect(container.querySelector('[data-role="user"]')).not.toBeNull();
    expect(container.querySelector('[data-role="assistant"]')).not.toBeNull();
  });

  test("shows a streaming cursor only while a message is streaming", () => {
    const { container } = render(MessageList, {
      conversation: conv([{ id: "m1", role: "assistant", text: "typing", streaming: true }]),
    });
    expect(container.querySelector("[data-cursor]")).not.toBeNull();
  });

  test("renders no bubbles for an empty conversation", () => {
    const { container } = render(MessageList, { conversation: conv([]) });
    expect(container.querySelectorAll("[data-role]")).toHaveLength(0);
  });

  test("shows a thinking indicator while awaiting the assistant", () => {
    const { container } = render(MessageList, {
      conversation: { messages: [{ id: "m1", role: "user", text: "hi", streaming: false }], awaiting: true },
    });
    const thinking = container.querySelector("[data-thinking]");
    expect(thinking).not.toBeNull();
    expect(thinking).toHaveAttribute("role", "status");
    expect(thinking!.querySelectorAll("[data-dot]")).toHaveLength(3);
  });
});
