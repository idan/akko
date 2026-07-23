/**
 * Storybook/browser-test mock for `jazz-tools/svelte` (aliased in .storybook/main.ts).
 *
 * The real `QuerySubscription` needs a running Jazz runtime + synced server. For
 * component design in isolation we return fixture rows synchronously. Fixtures are
 * carried on the query object (see ./schema.ts `app.messages.where`), so different
 * stories vary data purely by the `sessionId` they pass — no shared/global state.
 */
export class QuerySubscription<T extends { id: string }> {
  current: T[] | undefined;
  loading = false;
  error: Error | null = null;

  constructor(query: unknown | (() => unknown)) {
    const q = typeof query === "function" ? (query as () => unknown)() : query;
    this.current = ((q as { __rows?: T[] } | undefined)?.__rows ?? []) as T[];
  }
}
