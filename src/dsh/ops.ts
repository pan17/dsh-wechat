/**
 * DSH read/write operations behind the WeChat workspace/session/agent/model
 * commands. All service access goes through `ctx.get(...)` with undefined
 * checks — no runtime imports of `@deepseek-ai/*` packages.
 */

import type { BridgeContext } from "./sessions.js";

// ─── Structural service shapes (verified against the running harness) ───

export interface Workspace {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly createdAt: string;
  readonly sessionIds: readonly string[];
}

export interface SessionRecord {
  header: SessionHeader;
  live: boolean;
  persisted: boolean;
}

export interface SessionHeader {
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly origin?: "subagent";
  readonly agentPreset?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  description?: string;
}

export interface AgentPreset {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly broken?: string;
}

export interface ModelSelection {
  provider: string;
  model: string;
}

export interface WorkspaceRegistry {
  list(): Workspace[];
  create(path: string, title?: string): Promise<Workspace>;
  resolveByPath(path: string): Promise<Workspace | undefined>;
}

export interface SessionQuery {
  listSessions(): Promise<SessionRecord[]>;
  readTitle(sessionId: string): Promise<{ title?: string } | undefined>;
}

export interface LlmService {
  listProviders(): ProviderInfo[];
  listModels(provider: string): Promise<ModelInfo[]>;
}

export interface AgentPresetsService {
  list(): Promise<AgentPreset[]>;
  recompose(agentCtx: unknown, id: string): Promise<unknown>;
}

export interface AgentDefaultModelService {
  currentSelection(): ModelSelection;
  saveSelection(next: ModelSelection): Promise<void>;
}

export class DshOps {
  constructor(private readonly ctx: BridgeContext) {}

  private get<T>(name: string): T | undefined {
    return this.ctx.get<T>(name);
  }

  // ─── Workspaces ───

  listWorkspaces(): Workspace[] {
    return this.get<WorkspaceRegistry>("workspaceRegistry")?.list() ?? [];
  }

  async resolveWorkspaceByPath(path: string): Promise<Workspace | undefined> {
    try {
      return await this.get<WorkspaceRegistry>("workspaceRegistry")?.resolveByPath(path);
    } catch {
      return undefined;
    }
  }

  async createWorkspace(path: string): Promise<Workspace | undefined> {
    try {
      return await this.get<WorkspaceRegistry>("workspaceRegistry")?.create(path);
    } catch (err) {
      return undefined;
    }
  }

  // ─── Sessions ───

  async listSessions(): Promise<SessionRecord[]> {
    const query = this.get<SessionQuery>("sessionQuery");
    if (!query) return [];
    try {
      const all = await query.listSessions();
      // Top-level sessions only (no subagent origin).
      return all.filter((r) => r.header.origin !== "subagent");
    } catch {
      return [];
    }
  }

  async readSessionTitle(sessionId: string): Promise<string | undefined> {
    const query = this.get<SessionQuery>("sessionQuery");
    if (!query) return undefined;
    try {
      const snapshot = await query.readTitle(sessionId);
      return snapshot?.title;
    } catch {
      return undefined;
    }
  }

  // ─── Models ───

  listProviders(): ProviderInfo[] {
    return this.get<LlmService>("llm")?.listProviders() ?? [];
  }

  async listModels(provider: string): Promise<ModelInfo[]> {
    const llm = this.get<LlmService>("llm");
    if (!llm) return [];
    try {
      return await llm.listModels(provider);
    } catch {
      return [];
    }
  }

  defaultModelSelection(): ModelSelection | undefined {
    return this.get<AgentDefaultModelService>("agentDefaultModel")?.currentSelection();
  }

  async saveDefaultModel(selection: ModelSelection): Promise<boolean> {
    const service = this.get<AgentDefaultModelService>("agentDefaultModel");
    if (!service) return false;
    try {
      await service.saveSelection(selection);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Agent presets ───

  async listPresets(): Promise<AgentPreset[]> {
    const presets = this.get<AgentPresetsService>("agentPresets");
    if (!presets) return [];
    try {
      return await presets.list();
    } catch {
      return [];
    }
  }

  async recomposeAgent(agentCtx: unknown, id: string): Promise<boolean> {
    const presets = this.get<AgentPresetsService>("agentPresets");
    if (!presets || !agentCtx) return false;
    try {
      await presets.recompose(agentCtx, id);
      return true;
    } catch {
      return false;
    }
  }
}
