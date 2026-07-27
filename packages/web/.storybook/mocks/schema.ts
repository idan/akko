/**
 * Storybook/browser-test mock for `@akko/schema` (aliased in .storybook/main.ts).
 *
 * Only `app` is consumed by the frontend (JazzMessageList). We stub `app.messages.where`
 * to attach fixture rows keyed by `sessionId`, which the mock QuerySubscription reads.
 * This keeps the real Jazz runtime (and wasm) out of the Storybook/browser bundle.
 */
interface Row {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
}

const FIXTURES: Record<string, Row[]> = {
  sess_demo: [
    { id: "r1", sessionId: "sess_demo", role: "user", text: "Where does the Jazz projection get its rows?" },
    {
      id: "r2",
      sessionId: "sess_demo",
      role: "assistant",
      text: "From the backend projector: only finalized user + assistant messages are inserted into the Jazz `messages` table (doc 14).",
    },
    { id: "r3", sessionId: "sess_demo", role: "user", text: "And live tokens?" },
    { id: "r4", sessionId: "sess_demo", role: "assistant", text: "Those stay on the WebSocket — never projected." },
  ],
};

interface ActivityRow {
  id: string;
  sessionId: string;
  kind: string;
  text: string;
}
const ACTIVITY: Record<string, ActivityRow[]> = {};

export const app = {
  messages: {
    where: ({ sessionId }: { sessionId: string }) => {
      const rows = FIXTURES[sessionId] ?? [];
      return { __rows: rows, orderBy: () => ({ __rows: rows }) };
    },
  },
  activity: {
    where: ({ sessionId }: { sessionId: string }) => {
      const rows = ACTIVITY[sessionId] ?? [];
      return { __rows: rows, orderBy: () => ({ __rows: rows }) };
    },
  },
};
