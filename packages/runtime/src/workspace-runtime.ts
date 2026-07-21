/**
 * HostWorkspaceRuntimeFactory — slice-1 `WorkspaceRuntimeFactory` (doc 02).
 *
 * Binds a `Workspace` to pi's per-call parameters for `host` isolation: a cwd under the
 * workspace storage root, a per-workspace `ResourceLoader` + `SettingsManager`, and a
 * shared `ModelRuntime` from `DefaultCredentialProvider`. This is the module that makes
 * "no pi fork" true — tenancy is the bundle we pass in.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  CredentialProvider,
  SessionId,
  Workspace,
  WorkspaceRuntime,
  WorkspaceRuntimeFactory,
} from "@akko/core";

/**
 * Shared, single-instance model runtime for slice 1. Uses the global agent dir so it
 * picks up already-configured pi credentials/models. Per-workspace credential
 * partitioning and hub-brokered inference (doc 12) come later behind this interface.
 */
export class DefaultCredentialProvider implements CredentialProvider {
  #runtime?: ModelRuntime;
  readonly #agentDir: string;

  constructor(agentDir: string = getAgentDir()) {
    this.#agentDir = agentDir;
  }

  async for(_workspace: Workspace): Promise<{ modelRuntime: ModelRuntime }> {
    if (!this.#runtime) {
      this.#runtime = await ModelRuntime.create({
        authPath: join(this.#agentDir, "auth.json"),
        modelsPath: join(this.#agentDir, "models.json"),
      });
    }
    return { modelRuntime: this.#runtime };
  }
}

export class HostWorkspaceRuntimeFactory implements WorkspaceRuntimeFactory {
  #cache = new Map<string, WorkspaceRuntime>();
  readonly #credentials: CredentialProvider;
  readonly #agentDir: string;

  constructor(options?: { credentials?: CredentialProvider; agentDir?: string }) {
    this.#agentDir = options?.agentDir ?? getAgentDir();
    this.#credentials = options?.credentials ?? new DefaultCredentialProvider(this.#agentDir);
  }

  async get(workspace: Workspace): Promise<WorkspaceRuntime> {
    const existing = this.#cache.get(workspace.id);
    if (existing) return existing;

    const cwd = join(workspace.storageRoot, "tree");
    mkdirSync(cwd, { recursive: true });

    const settingsManager = SettingsManager.create(cwd, this.#agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: this.#agentDir });
    await resourceLoader.reload();
    const { modelRuntime } = await this.#credentials.for(workspace);

    const runtime: WorkspaceRuntime = {
      workspace,
      execution: { isolation: "host", cwd },
      modelRuntime,
      settingsManager,
      resourceLoader,
      agentDir: this.#agentDir,
      sessionManagerFor: async (_sessionId: SessionId) => SessionManager.inMemory(cwd),
    };
    this.#cache.set(workspace.id, runtime);
    return runtime;
  }

  async release(workspaceId: Workspace["id"]): Promise<void> {
    this.#cache.delete(workspaceId);
  }
}
