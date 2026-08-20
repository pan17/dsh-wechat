/**
 * DSH read/write operations behind the WeChat workspace/session/agent/model
 * commands. All service access goes through `ctx.get(...)` with undefined
 * checks — no runtime imports of `@deepseek-ai/*` packages.
 */

import type { Agent } from "./types.js";
import type { SessionProjectionService } from "./types.js";
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
  /**
   * Registry-global archive set (dsh-workspace): sessions hidden from every
   * grouping surface. Archiving keeps the session's workspace slot; this is
   * the "hidden from lists" marker the GUI sidebar honors.
   */
  readonly archivedSessionIds: readonly string[];
}

export interface SessionQuery {
  listSessions(): Promise<SessionRecord[]>;
  readTitle(sessionId: string): Promise<{ title?: string } | undefined>;
  /** Lightweight raw-log event records (ascending seq), for recency recovery. */
  listEvents(sessionId: string): Promise<Array<{ type: string; time: number; data?: unknown; seq?: number }>>;
}

export interface HistoryEntry {
  role: "user" | "assistant";
  text: string;
  time: number;
}

export interface LlmService {
  listProviders(): ProviderInfo[];
  listModels(provider: string): Promise<ModelInfo[]>;
  /** Exact-route metadata: context window, reasoning efforts, etc. */
  resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: ModelReasoningInfo }>;
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

/**
 * Minimal structural surface of the `commands` service (dsh-commands).
 * Only the `execute` entry is needed — the bridge mirrors the GUI's
 * command palette by dispatching each recognized slash command through
 * the same registry, so the registered handler (e.g. dsh-command-compact)
 * owns the `command/run` ↔ `command/done` lifecycle and the localized
 * CommandResult text. We type `commandId` as opaque because the bridge
 * never correlates across sessions.
 */
export interface CommandsService {
  execute(
    agent: Agent,
    line: string,
    signal: AbortSignal,
  ): Promise<{ commandId: unknown; result: CommandResultShape } | undefined>;
}

/** Minimal shape of the handler's normalized result (dsh-commands CommandResult). */
export interface CommandResultShape {
  readonly kind: "success" | "error";
  readonly text?: string;
  readonly sourceEventSeq?: number;
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

  /** Sessions hidden from every grouping surface (dsh-workspace archive set). */
  archivedSessionIds(): readonly string[] {
    return this.get<WorkspaceRegistry>("workspaceRegistry")?.archivedSessionIds ?? [];
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
      // Top-level sessions only (no subagent origin), and never archived
      // sessions — the same "hidden from every grouping surface" rule the
      // GUI sidebar applies (dsh-workspace archivedSessionIds).
      const archived = new Set(
        this.get<WorkspaceRegistry>("workspaceRegistry")?.archivedSessionIds ?? [],
      );
      return all.filter((r) => r.header.origin !== "subagent" && !archived.has(r.header.id));
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

  /**
   * Time of the session's last user-prompt event (`user/message`), read from
   * the raw log. Used to recover recency after a restart, when the in-memory
   * activity map is empty; undefined when the log holds no user prompt.
   */
  async lastUserMessageTime(sessionId: string): Promise<number | undefined> {
    const query = this.get<SessionQuery>("sessionQuery");
    if (!query) return undefined;
    try {
      const records = await query.listEvents(sessionId);
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i]!.type === "user/message") return records[i]!.time;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // ─── History ──────────────────────────────────────────────────────────────

  /**
   * Extract display text from a session event's data payload.
   * Handles multiple host shapes: `data.message.content[]`, `data.content`,
   * `data.text`, etc. Returns empty string when nothing text-like is found.
   */
  private extractHistoryText(data: unknown): string {
    if (!data || typeof data !== "object") {
      if (typeof data === "string") return data;
      return "";
    }
    const d = data as Record<string, unknown>;
    // Primary: DSH message shape `data.message.content: [{type:"text",text}]`
    const msg = d.message as Record<string, unknown> | undefined;
    if (msg && Array.isArray(msg.content)) {
      const parts = (msg.content as Array<Record<string, unknown>>)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => String(b.text));
      if (parts.length > 0) return parts.join("\n");
    }
    // Fallback: `data.content` array (some versions flatten)
    if (Array.isArray(d.content)) {
      const parts = (d.content as Array<Record<string, unknown>>)
        .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string")
        .map((b) => String((b as { text: string }).text));
      if (parts.length > 0) return parts.join("\n");
    }
    // Fallback: plain `data.text`
    if (typeof d.text === "string" && d.text.trim()) return d.text;
    // Fallback: `data.prompt` or `data.input` string
    if (typeof d.prompt === "string" && d.prompt.trim()) return d.prompt;
    if (typeof d.input === "string" && d.input.trim()) return d.input;
    return "";
  }

  /**
   * Retrieve the most recent `limit` conversation entries (user + assistant)
   * for `sessionId`, ordered oldest→newest.
   *
   * Strategy:
   *  1. Try in-memory `agent.session.events` via `ctx.get("agents")` — fast,
   *     no I/O, survives even when `sessionQuery` is unavailable.
   *  2. Fall back to persisted `sessionQuery.listEvents(sessionId)` — works
   *     after restart or when agent is not live.
   *
   * Filters to `user/message` (role=user) and `assistant/message`
   * (role=assistant). Other event types (tool results, system, etc.) are
   * ignored to keep the WeChat view concise.
   *
   * Returns `[]` on any error or when no history exists — caller renders
   * a friendly empty-state message.
   */
  async getSessionHistory(sessionId: string, limit: number): Promise<HistoryEntry[]> {
    const cap = Math.max(1, Math.min(limit, 20));
    // 1) In-memory fast path
    try {
      const agents = this.get<{ get(id: string): { session?: { events?: readonly { type: string; time?: number; data?: unknown }[] } } | undefined }>("agents");
      const agent = agents?.get(sessionId);
      const events = agent?.session?.events;
      if (Array.isArray(events) && events.length > 0) {
        const entries: HistoryEntry[] = [];
        for (const ev of events) {
          if (ev.type !== "user/message" && ev.type !== "assistant/message") continue;
          const text = this.extractHistoryText(ev.data);
          if (!text) continue;
          const role = ev.type === "user/message" ? "user" as const : "assistant" as const;
          entries.push({ role, text, time: typeof ev.time === "number" ? ev.time : Date.now() });
        }
        if (entries.length > 0) {
          // events are already in chronological order (ascending seq)
          return entries.slice(-cap);
        }
      }
    } catch {
      // fall through to persisted path
    }

    // 2) Persisted fallback
    const query = this.get<SessionQuery>("sessionQuery");
    if (!query) return [];
    try {
      const records = await query.listEvents(sessionId);
      const entries: HistoryEntry[] = [];
      for (const r of records) {
        if (r.type !== "user/message" && r.type !== "assistant/message") continue;
        const text = this.extractHistoryText((r as { data?: unknown }).data);
        if (!text) continue;
        const role = r.type === "user/message" ? "user" as const : "assistant" as const;
        entries.push({ role, text, time: r.time });
      }
      return entries.slice(-cap);
    } catch {
      return [];
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
      const info = await llm.resolveModelInfo(provider, model);
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

  // ─── Commands ───

  /**
   * The global `commands` service (dsh-commands). Exposes `execute` to dispatch
   * slash commands through the same registry the GUI's command palette reads,
   * so the registered handler — including `command/run` ↔ `command/done`
   * lifecycle events — runs unchanged for WeChat users.
   */
  commands(): CommandsService | undefined {
    return this.get<CommandsService>("commands");
  }

  // ─── Session projections ───

  /**
   * The `ctx.sessionProjections` registry (`@deepseek-ai/dsh-session-projection`).
   * Hosts the whole-value projections every domain plugin registers for a
   * session — plan mode (`key: 'plan'`), goal (`key: 'goal'`), and any
   * future mode any third-party plugin adds. The WeChat bridge uses
   * `snapshot(agent.session)` to read the whole map at once and render
   * it in `/status`. Returns `undefined` when the registry is not
   * composed (e.g. minimal headless profiles) — the caller treats that
   * as "no projections, omit the section" without any further signal.
   */
  sessionProjections(): SessionProjectionService | undefined {
    return this.get<SessionProjectionService>("sessionProjections");
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

  // ─── Helpers for cross-session notification recipients ───

  /**
   * Find the full session record for `sessionId`, or undefined when not found
   * or when the session is filtered (archived / subagent). Mirrors listSessions filtering.
   */
  async findSessionRecord(sessionId: string): Promise<SessionRecord | undefined> {
    const all = await this.listSessions();
    return all.find((r) => r.header.id === sessionId);
  }

  /**
   * Workspace owning `sessionId`, if any. Resolved via the session's cwd and workspaceRegistry.
   */
  async workspaceOfSession(sessionId: string): Promise<Workspace | undefined> {
    const record = await this.findSessionRecord(sessionId);
    if (!record?.header.cwd) return undefined;
    const workspaces = this.listWorkspaces();
    return workspaces.find((w) => w.path === record.header.cwd) ?? workspaces.find((w) => w.sessionIds.includes(sessionId));
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
