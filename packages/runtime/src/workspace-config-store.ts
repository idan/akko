/**
 * Workspace-owned configuration: agent types and skills, stored in canonical SQLite
 * (doc 04) rather than on a developer's filesystem.
 *
 * Why the database:
 * - **Portability.** The whole of a workspace's configuration travels in one file.
 * - **It is workspace data, not host data.** A session may be rehydrated on any node
 *   (doc 12); config that lives on one machine's disk does not travel with it.
 * - **It makes management possible.** Toggling a skill's prompt visibility is a column
 *   update here, where the alternative was mutating the user's own skill files.
 *
 * Disk sources are *not* replaced. pi keeps discovering skills from its usual locations,
 * and project skills committed to a repo should stay files — git-diffable and editable in
 * an editor. These rows are an additional, workspace-scoped source (see
 * `MergedResourceLoader`), and the inventory reports `source` so the origin stays legible.
 */
import type { SqliteAdapter, WorkspaceId } from "@akko/core";

/** A workspace-owned skill: pi's SKILL.md content plus the fields we index on. */
export interface StoredSkill {
  workspaceId: WorkspaceId;
  name: string;
  description: string;
  /** Full SKILL.md body (without frontmatter) — materialized to disk for pi to read. */
  content: string;
  /** `disable-model-invocation`: keeps it callable via `/skill:name` without prompt cost. */
  hiddenFromPrompt: boolean;
  updatedAt: number;
}

/** A workspace-owned agent-type preset (doc 03). */
export interface StoredAgentType {
  workspaceId: WorkspaceId;
  name: string;
  description?: string;
  model?: string;
  thinkingLevel?: string;
  /** Tool allowlist; empty means "pi's defaults". */
  tools?: string[];
  instructions: string;
  updatedAt: number;
}

export class SqliteWorkspaceConfigStore {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_skills (
        workspace_id       TEXT NOT NULL,
        name               TEXT NOT NULL,
        description        TEXT NOT NULL,
        content            TEXT NOT NULL,
        hidden_from_prompt INTEGER NOT NULL DEFAULT 0,
        updated_at         INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, name)
      );
      CREATE TABLE IF NOT EXISTS workspace_agent_types (
        workspace_id   TEXT NOT NULL,
        name           TEXT NOT NULL,
        description    TEXT,
        model          TEXT,
        thinking_level TEXT,
        tools          TEXT,
        instructions   TEXT NOT NULL,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, name)
      );
    `);
  }

  // ---- skills ----

  listSkills(workspaceId: WorkspaceId): StoredSkill[] {
    const rows = this.#db
      .prepare(
        `SELECT workspace_id, name, description, content, hidden_from_prompt, updated_at
         FROM workspace_skills WHERE workspace_id = ? ORDER BY name`,
      )
      .all<{
        workspace_id: string;
        name: string;
        description: string;
        content: string;
        hidden_from_prompt: number;
        updated_at: number;
      }>(workspaceId);
    return rows.map((r) => ({
      workspaceId: r.workspace_id as WorkspaceId,
      name: r.name,
      description: r.description,
      content: r.content,
      hiddenFromPrompt: r.hidden_from_prompt === 1,
      updatedAt: r.updated_at,
    }));
  }

  upsertSkill(skill: Omit<StoredSkill, "updatedAt"> & { updatedAt?: number }): void {
    this.#db
      .prepare(
        `INSERT INTO workspace_skills (workspace_id, name, description, content, hidden_from_prompt, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, name) DO UPDATE SET
           description=excluded.description, content=excluded.content,
           hidden_from_prompt=excluded.hidden_from_prompt, updated_at=excluded.updated_at`,
      )
      .run(
        skill.workspaceId,
        skill.name,
        skill.description,
        skill.content,
        skill.hiddenFromPrompt ? 1 : 0,
        skill.updatedAt ?? Date.now(),
      );
  }

  /** Toggle prompt visibility. Returns false if the workspace doesn't own that skill. */
  setSkillHidden(workspaceId: WorkspaceId, name: string, hidden: boolean): boolean {
    const res = this.#db
      .prepare(
        `UPDATE workspace_skills SET hidden_from_prompt = ?, updated_at = ?
         WHERE workspace_id = ? AND name = ?`,
      )
      .run(hidden ? 1 : 0, Date.now(), workspaceId, name);
    return (res?.changes ?? 0) > 0;
  }

  deleteSkill(workspaceId: WorkspaceId, name: string): boolean {
    const res = this.#db
      .prepare("DELETE FROM workspace_skills WHERE workspace_id = ? AND name = ?")
      .run(workspaceId, name);
    return (res?.changes ?? 0) > 0;
  }

  // ---- agent types ----

  listAgentTypes(workspaceId: WorkspaceId): StoredAgentType[] {
    const rows = this.#db
      .prepare(
        `SELECT workspace_id, name, description, model, thinking_level, tools, instructions, updated_at
         FROM workspace_agent_types WHERE workspace_id = ? ORDER BY name`,
      )
      .all<{
        workspace_id: string;
        name: string;
        description: string | null;
        model: string | null;
        thinking_level: string | null;
        tools: string | null;
        instructions: string;
        updated_at: number;
      }>(workspaceId);
    return rows.map((r) => ({
      workspaceId: r.workspace_id as WorkspaceId,
      name: r.name,
      description: r.description ?? undefined,
      model: r.model ?? undefined,
      thinkingLevel: r.thinking_level ?? undefined,
      // Stored as JSON so a tool name containing a comma can never corrupt the list.
      tools: r.tools ? (JSON.parse(r.tools) as string[]) : undefined,
      instructions: r.instructions,
      updatedAt: r.updated_at,
    }));
  }

  upsertAgentType(type: Omit<StoredAgentType, "updatedAt"> & { updatedAt?: number }): void {
    this.#db
      .prepare(
        `INSERT INTO workspace_agent_types
           (workspace_id, name, description, model, thinking_level, tools, instructions, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, name) DO UPDATE SET
           description=excluded.description, model=excluded.model,
           thinking_level=excluded.thinking_level, tools=excluded.tools,
           instructions=excluded.instructions, updated_at=excluded.updated_at`,
      )
      .run(
        type.workspaceId,
        type.name,
        type.description ?? null,
        type.model ?? null,
        type.thinkingLevel ?? null,
        type.tools && type.tools.length > 0 ? JSON.stringify(type.tools) : null,
        type.instructions,
        type.updatedAt ?? Date.now(),
      );
  }

  deleteAgentType(workspaceId: WorkspaceId, name: string): boolean {
    const res = this.#db
      .prepare("DELETE FROM workspace_agent_types WHERE workspace_id = ? AND name = ?")
      .run(workspaceId, name);
    return (res?.changes ?? 0) > 0;
  }
}
