/**
 * Agent types — named subagent presets defined as `.md` files (doc 03).
 *
 * Takes the agent-type convention from the pi ecosystem as inspiration, but stays thin:
 * frontmatter configures the child's model, thinking level and tool allowlist, and the
 * body becomes instructions prepended to the task. A "researcher" that can only read, a
 * "reviewer" on a cheaper model — specialisation without a plugin system.
 *
 *     ---
 *     description: Read-only research over the codebase
 *     model: anthropic/claude-3-5-haiku
 *     thinkingLevel: low
 *     tools: [read, grep, find, ls]
 *     ---
 *     You are a research subagent. Answer only from files you actually read.
 *
 * Parsing reuses pi's own `parseFrontmatter`, so these files behave like every other
 * `.md` convention in the ecosystem rather than inventing a dialect.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentType {
  /** File name without extension — what `agentType` refers to. */
  name: string;
  /** Shown to the parent model so it can pick appropriately. */
  description?: string;
  /** `provider/id`; falls back to the parent's model. */
  model?: string;
  thinkingLevel?: string;
  /** Allowlist. Absent means pi's defaults (minus delegation, which children never get). */
  tools?: string[];
  /** Body of the file: instructions prepended to each task. */
  instructions: string;
}

/** Frontmatter shape we understand; anything else is ignored rather than rejected. */
interface AgentFrontmatter extends Record<string, unknown> {
  description?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  tools?: unknown;
}

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Accept `[read, grep]` (array) or `read, grep` (string), since both look natural. */
const asStringArray = (v: unknown): string[] | undefined => {
  const items = Array.isArray(v)
    ? v
    : typeof v === "string"
      ? v.split(",")
      : undefined;
  if (!items) return undefined;
  const out = items.map((x) => String(x).trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
};

/** Parse one agent-type file. Returns undefined if it has no usable content. */
export function parseAgentType(name: string, content: string): AgentType | undefined {
  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
  const instructions = body.trim();
  const type: AgentType = {
    name,
    description: asString(frontmatter?.description),
    model: asString(frontmatter?.model),
    thinkingLevel: asString(frontmatter?.thinkingLevel),
    tools: asStringArray(frontmatter?.tools),
    instructions,
  };
  // A file with neither instructions nor configuration would silently do nothing.
  if (!instructions && !type.model && !type.tools && !type.thinkingLevel) return undefined;
  return type;
}

/**
 * Load every `.md` agent type in a directory. A missing directory is normal (most
 * workspaces define none), so it yields an empty map rather than throwing — a broken or
 * absent preset must never stop a session from being created.
 */
export function loadAgentTypes(dir: string): Map<string, AgentType> {
  const types = new Map<string, AgentType>();
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return types;
    entries = readdirSync(dir);
  } catch {
    return types;
  }

  for (const file of entries) {
    if (extname(file).toLowerCase() !== ".md") continue;
    const name = basename(file, extname(file));
    try {
      const parsed = parseAgentType(name, readFileSync(join(dir, file), "utf8"));
      if (parsed) types.set(name, parsed);
    } catch (error) {
      // One malformed file shouldn't hide the rest.
      console.error(`[akko] failed to load agent type ${file}:`, error);
    }
  }
  return types;
}

/** Prepend an agent type's instructions to a task. */
export function applyAgentType(type: AgentType | undefined, task: string): string {
  if (!type?.instructions) return task;
  return `${type.instructions}\n\n---\n\nTask:\n${task}`;
}

/** One-line summary of the available types, for the spawn tool's description. */
export function describeAgentTypes(types: Map<string, AgentType>): string {
  if (types.size === 0) return "";
  return [...types.values()]
    .map((t) => (t.description ? `${t.name} (${t.description})` : t.name))
    .join("; ");
}
