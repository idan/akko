<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, fn, userEvent } from "storybook/test";
  import ChatView from "./ChatView.svelte";
  import type { AkkoClient } from "../client.svelte.ts";
  import type { ConversationState } from "../conversation.ts";

  // ChatView reads a handful of fields + sendPrompt(); a plain stub is enough.
  function client(over: Partial<AkkoClient> & { sendPrompt?: AkkoClient["sendPrompt"] } = {}): AkkoClient {
    return {
      sessions: [],
      models: [],
      activeSessionId: null,
      activeConversation: { messages: [] } as ConversationState,
      activeJazzId: undefined,
      error: null,
      sendPrompt: fn(),
      setModel: fn(),
      ...over,
    } as unknown as AkkoClient;
  }

  const active = client({
    sessions: [{ id: "s1", title: "Roadmap review", model: "anthropic/claude-sonnet-4-5" }] as AkkoClient["sessions"],
    activeSessionId: "s1",
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { provider: "anthropic", id: "claude-3-5-haiku", name: "Claude Haiku 3.5" },
    ] as AkkoClient["models"],
    activeConversation: {
      messages: [
        { id: "m1", role: "user", text: "What are the next steps?", streaming: false },
        { id: "m2", role: "assistant", text: "Close out the Jazz slice, then model routing.", streaming: false },
      ],
    },
  });

  const { Story } = defineMeta({
    title: "Chat/ChatView",
    component: ChatView,
    tags: ["autodocs"],
    args: { onmenu: fn() },
    parameters: { layout: "fullscreen" },
  });
</script>

<!-- ChatView fills the main pane (flex column, full height). -->
<Story
  name="Active session"
  args={{ client: active }}
  play={async ({ canvas, args }) => {
    const box = canvas.getByRole("textbox");
    await userEvent.type(box, "ship it");
    await userEvent.keyboard("{Enter}");
    await expect((args.client as AkkoClient).sendPrompt).toHaveBeenCalledWith("ship it");
  }}
>
  {#snippet template(args)}
    <div style="height: 100vh; display: flex;"><ChatView {...args} /></div>
  {/snippet}
</Story>

<Story name="No session" args={{ client: client() }}>
  {#snippet template(args)}
    <div style="height: 100vh; display: flex;"><ChatView {...args} /></div>
  {/snippet}
</Story>

<Story
  name="With error"
  args={{ client: client({ error: "websocket error" }) }}
  play={async ({ canvas }) => {
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent("websocket error");
  }}
>
  {#snippet template(args)}
    <div style="height: 100vh; display: flex;"><ChatView {...args} /></div>
  {/snippet}
</Story>
