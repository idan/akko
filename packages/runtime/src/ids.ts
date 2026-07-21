/**
 * Id generation for the branded domain ids (doc 02).
 *
 * Ids are prefixed, URL-safe strings shaped like `ses_V1StGXR8Z5jdHi6BmyT`:
 * a short type prefix, an underscore, then a full-entropy `nanoid()` (21 chars,
 * ~126 bits — comparable to a UUIDv4). The prefix makes ids self-describing in
 * urls and logs, and complements the compile-time branding by making a
 * "wrong id type" easy to spot at runtime too.
 */
import type {
  CommandId,
  EntryId,
  NodeId,
  PrincipalId,
  SessionId,
  WorkspaceId,
} from "@akko/core";
import { nanoid } from "nanoid";

/** Type prefixes. Keep these stable — they may end up in urls and stored data. */
export const ID_PREFIXES = {
  principal: "prn",
  workspace: "wsp",
  session: "ses",
  command: "cmd",
  node: "nod",
} as const;

const prefixed = (prefix: string): string => `${prefix}_${nanoid()}`;

export const newPrincipalId = (): PrincipalId =>
  prefixed(ID_PREFIXES.principal) as PrincipalId;
export const newWorkspaceId = (): WorkspaceId =>
  prefixed(ID_PREFIXES.workspace) as WorkspaceId;
export const newSessionId = (): SessionId => prefixed(ID_PREFIXES.session) as SessionId;
export const newCommandId = (): CommandId => prefixed(ID_PREFIXES.command) as CommandId;
export const newNodeId = (): NodeId => prefixed(ID_PREFIXES.node) as NodeId;

/**
 * NOTE: `EntryId` is pi's own 8-char entry id within a session tree (see
 * `domain.ts`); pi mints these, not Akko. This helper exists only for the rare
 * case where Akko needs a standalone id and is intentionally left *unprefixed*
 * so it never diverges from pi's format. Prefer using pi's entry ids directly.
 */
export const newEntryId = (): EntryId => nanoid(8) as EntryId;
