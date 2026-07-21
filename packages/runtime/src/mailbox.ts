/**
 * AkkoMailbox — the per-session actor mailbox (doc 03).
 *
 * A single-consumer, in-order, attributed queue. Callers `post()` attributed
 * commands; the mailbox drains them one at a time, running the authorization gate
 * (doc 02) then applying the command to the live session. This is where serialization,
 * authorization, and concurrency policy meet — the only sanctioned way to mutate a
 * session.
 */
import type { Command, Decision, Mailbox, MailboxResult, PrincipalId } from "@akko/core";

export interface AkkoMailboxDeps {
  /** Authorization + concurrency gate. Runs before each command is applied. */
  authorize(command: Command): Decision | Promise<Decision>;
  /**
   * Apply an authorized command to the live session (e.g. call pi's
   * prompt/steer/followUp/abort). Should resolve once the command is *accepted*
   * (not when the whole agent run finishes), so the mailbox stays responsive for
   * steering during a run. Throwing rejects the command.
   */
  apply(command: Command): Promise<void>;
}

interface QueueItem {
  command: Command;
  settle: (result: MailboxResult) => void;
}

export class AkkoMailbox implements Mailbox {
  #queue: QueueItem[] = [];
  #draining = false;
  readonly #deps: AkkoMailboxDeps;

  constructor(deps: AkkoMailboxDeps) {
    this.#deps = deps;
  }

  post(command: Command): Promise<MailboxResult> {
    return new Promise<MailboxResult>((resolve) => {
      this.#queue.push({ command, settle: resolve });
      void this.#drain();
    });
  }

  pending(): Array<{ actorId: PrincipalId; verb: Command["verb"] }> {
    return this.#queue.map((item) => ({
      actorId: item.command.actorId,
      verb: item.command.verb,
    }));
  }

  size(): number {
    return this.#queue.length;
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const item = this.#queue.shift()!;
        try {
          const decision = await this.#deps.authorize(item.command);
          if (!decision.allow) {
            item.settle({ accepted: false, reason: decision.reason ?? "not authorized" });
            continue;
          }
          await this.#deps.apply(item.command);
          item.settle({ accepted: true });
        } catch (error) {
          item.settle({
            accepted: false,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}
