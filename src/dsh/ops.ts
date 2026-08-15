/**
 * DSH read/write operations behind the WeChat workspace/session/agent/model
 * commands. All service access goes through `ctx.get(...)` with undefined
 * checks — no runtime imports of `@deepseek-ai/*` packages.
 */

import type { BridgeContext } from "./sessions.js";

/** Nominal id of one registered settings namespace (dsh-settings brand). */
export type SettingsNamespace = string & { readonly __settingsNamespace?: undefined };

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
  /** Adapter-owned reasoning effort id; absent = provider/model default. */
  reasoningEffort?: string;
}

/** Reasoning-effort capability of one exact model route (dsh-llm). */
export interface ModelReasoningInfo {
  /** Supported efforts in adapter-preferred display order. */
  efforts: readonly { id: string; name: string; description?: string }[];
  /** Adapter-configured default materialized when callers omit an effort. */
  defaultEffort?: string;
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
  /** Exact-route metadata: context window, reasoning efforts, etc. */
  resolveModel(provider: string, model: string): Promise<{ reasoning?: ModelReasoningInfo }>;
}

export interface AgentPresetsService {
  list(): Promise<AgentPreset[]>;
  recompose(agentCtx: unknown, id: string): Promise<unknown>;
  /** Preset id mounted when a caller names none (dsh-agent-presets). */
  defaultId?: string;
}

export interface AgentDefaultModelService {
  currentSelection(): ModelSelection;
  saveSelection(next: ModelSelection): Promise<void>;
}

/** One session event as consumed by the permission fold (structural shape). */
export interface SessionEventLike {
  readonly type: string;
  readonly data?: unknown;
}

/** Minimal structural surface of the `permissionPresets` service (dsh-permission-presets). */
export interface PermissionPresetsService {
  /** Advertised preset names, in table declaration order. */
  readonly names: readonly string[];
  /** Preset selected as the default for future sessions (settings-first). */
  readonly defaultPreset: string;
  /** Effective preset for a session's event log, or `custom` when nothing matches. */
  current(events: readonly SessionEventLike[]): string;
  /** Switch one session's permission preset (records events + writes knobs). */
  set(session: unknown, name: string): void;
  /** Resolve a preset's knob bundle. */
  resolve(name: string): { sandbox: string; approval: string; name?: string; description?: string };
  /** Build the client option for a table entry or `custom`. */
  optionOf(name: string): { value: string; name: string; description?: string };
}

/** Approximate context occupancy (dsh-token-meter `contextPressure` projection). */
export interface ContextPressureProjection {
  /** Provider-reported prompt tokens of the most recent request. */
  pressureTokens?: number;
  /** What the NEXT request's prompt would cost (pressure + surface delta). */
  projectedTokens?: number;
  /** Newest recorded model route capacity (total context window). */
  contextWindow?: number;
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

  /** Reasoning-effort capability of one exact model route, or undefined. */
  async resolveModelReasoning(provider: string, model: string): Promise<ModelReasoningInfo | undefined> {
    const llm = this.get<LlmService>("llm");
    if (!llm) return undefined;
    try {
      const info = await llm.resolveModel(provider, model);
      return info.reasoning;
    } catch {
      return undefined;
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

  defaultPresetId(): string | undefined {
    const presets = this.get<AgentPresetsService>("agentPresets");
    try {
      return presets?.defaultId;
    } catch {
      return undefined;
    }
  }

  /**
   * Persist the deployment-wide default preset into the DSH settings document
   * (`agent-presets` namespace) — the exact document the GUI settings page
   * edits, so a change from WeChat shows up there and vice versa. Returns
   * false when no settings provider is mounted or the write is refused.
   */
  async saveDefaultPreset(presetId: string): Promise<boolean> {
    const settings = this.get<{
      update(ns: SettingsNamespace, patch: object): Promise<void>;
    }>("settings");
    if (!settings) return false;
    try {
      await settings.update("agent-presets" as SettingsNamespace, { default: presetId });
      return true;
    } catch (err) {
      console.error(`[dsh-wechat] save default preset failed: ${String(err)}`);
      return false;
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

  // ─── Permission presets ───

  permissionPresets(): PermissionPresetsService | undefined {
    return this.get<PermissionPresetsService>("permissionPresets");
  }

  /** The deployment default permission preset for new sessions (settings-first). */
  permissionDefault(): string | undefined {
    return this.permissionPresets()?.defaultPreset;
  }

  /**
   * Persist the default permission preset into the DSH settings document
   * (`permission` namespace) — the exact document the GUI settings page's
   * Permission row edits, so a change from WeChat shows up there and vice
   * versa. New sessions pick it up natively (`pinInitialPermission`).
   * Returns false when no settings provider is mounted or the write is
   * refused.
   */
  async saveDefaultPermission(presetName: string): Promise<boolean> {
    const settings = this.get<{
      update(ns: SettingsNamespace, patch: object): Promise<void>;
    }>("settings");
    if (!settings) return false;
    try {
      await settings.update("permission" as SettingsNamespace, { defaultPreset: presetName });
      return true;
    } catch (err) {
      console.error(`[dsh-wechat] save default permission failed: ${String(err)}`);
      return false;
    }
  }

  // ─── Context pressure (token meter) ───

  /** Approximate context occupancy for one session (the GUI's context meter source). */
  contextPressure(session: unknown): ContextPressureProjection | undefined {
    const projections = this.get<{
      snapshot(session: unknown): { values: Partial<Record<string, unknown>> };
    }>("sessionProjections");
    if (!projections) return undefined;
    try {
      const snapshot = projections.snapshot(session);
      const value = snapshot.values.contextPressure;
      if (!value || typeof value !== "object") return undefined;
      const p = value as Partial<ContextPressureProjection>;
      if (p.projectedTokens === undefined && p.contextWindow === undefined) return undefined;
      return {
        ...(p.pressureTokens !== undefined ? { pressureTokens: p.pressureTokens } : {}),
        ...(p.projectedTokens !== undefined ? { projectedTokens: p.projectedTokens } : {}),
        ...(p.contextWindow !== undefined ? { contextWindow: p.contextWindow } : {}),
      };
    } catch {
      return undefined;
    }
  }
}
