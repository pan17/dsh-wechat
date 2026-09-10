/**
 * DSH read/write operations behind the WeChat workspace/session/agent/model
 * commands. All service access goes through `ctx.get(...)` with undefined
 * checks — no runtime imports of `@deepseek-ai/*` packages.
 */

import type { Agent, AgentSession } from "./types.js";
import { sessionEvents } from "./types.js";
import type { SessionProjectionService } from "./types.js";
import type { BridgeContext } from "./sessions.js";

/** Nominal id of one registered settings namespace (dsh-settings brand). */
export type SettingsNamespace = string & { readonly __settingsNamespace?: undefined };

/**
 * Busy-time delivery behavior for user messages (DSH `ui-conversation.busyEnter`).
 * `queue` = ordinary follow-up turn; `steer` = splice into the running turn at
 * the nearest step boundary. The value lives in the host user-settings document
 * (`$DSH_HOME/settings.yaml`) — the exact field the GUI's General Settings
 * 「繁忙时 Enter 键行为」 row edits — so WeChat and the GUI always agree.
 */
export type BusyEnterBehavior = "queue" | "steer";

/** Settings namespace owning the busy-Enter preference (dsh-client-ui-conversation). */
export const BUSY_ENTER_NAMESPACE = "ui-conversation";

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
  /**
   * Full validated log (0.1.2+). `listEvents` no longer carries `data`, so
   * `/history` prefers this when the host exposes it.
   */
  readSession?(sessionId: string): Promise<{
    events: Array<{ type: string; time?: number; data?: unknown }>;
  }>;
}

/** Listing facts folded from a session log without a full `listEvents` inspect. */
export interface SessionListFacts {
  preset?: string;
  title?: string;
  lastUserMessageTime?: number;
}

/** Durable projection-cache snapshot used as a zero-I/O listing hint. */
interface ProjectionCacheService {
  cachedSnapshot(
    header: SessionHeader,
    inheritedEventCount: number,
  ): { values?: Record<string, unknown> } | undefined;
}

/**
 * Outcome of reading a session log for "has the user spoken?" checks.
 * `ok: false` means the log could not be validated (corrupt persistence);
 * that is NOT a blank session.
 */
export type SessionLogActivity =
  | { ok: true; lastUserMessageTime?: number }
  | { ok: false; error: string };

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
  /**
   * Mirrors `@deepseek-ai/dsh-commands.CommandRuntime.execute`. The host
   * signature is `(agent, line, images, signal)` — `images` is the composer
   * attachment batch (always `[]` from WeChat; there is no composer), and
   * `signal` is the UI request's cancellation signal. The previous 3-arg
   * shape put the signal in `images`'s slot, leaving `signal` undefined
   * inside the host and breaking every native command with
   * `Cannot read properties of undefined (reading 'aborted')`.
   */
  execute(
    agent: Agent,
    line: string,
    images: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ commandId: unknown; result: CommandResultShape } | undefined>;
}

/** Minimal shape of the handler's normalized result (dsh-commands CommandResult). */
export interface CommandResultShape {
  readonly kind: "success" | "error";
  readonly text?: string;
  readonly sourceEventSeq?: number;
}

/**
 * Minimal structural surface of the host user-settings service (`ctx.settings`,
 * dsh-settings). `get(ns)` returns the schema-resolved section (`undefined`
 * while the namespace is unregistered); `update(ns, patch)` merges a patch
 * into the namespace's user layer and persists it to the settings document.
 */
export interface SettingsService {
  get(ns: SettingsNamespace): unknown;
  update(ns: SettingsNamespace, patch: object): Promise<void>;
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

  /**
   * Latest `session/title` text. Does not call host `readTitle()` (that
   * inspects the complete validated log). Live events / projection cache /
   * the raw-log fold used by `/s list` are enough for WeChat labels.
   */
  async readSessionTitle(sessionId: string, cwd?: string, header?: SessionHeader): Promise<string | undefined> {
    if (!sessionId) return undefined;
    const facts = await this.readSessionListFacts(sessionId, cwd, header);
    return facts.title;
  }

  /**
   * The preset a session actually runs under, with the same precedence the
   * host reads (`@deepseek-ai/dsh-agent-presets.resolveSessionPreset`):
   * newest `agent-preset/selected` event wins, else the header's frozen
   * creation value, else undefined.
   *
   * Reading the header alone silently reverts a session that was switched
   * after creation — the same bug class the host module's doc-comment calls
   * out: "Reconstruction reads resolveSessionPreset, never the header alone."
   * The bridge surfaces `/s list` and `/status` from this path.
   * `/preset status` reports the deployment default instead.
   *
   * Why a raw log read here, not `sessionQuery.listEvents`: that service
   * returns lightweight `{sessionId, seq, type, time, surface}` records
   * (a recency-recovery shape) and intentionally drops `data` to keep the
   * surface small. The `agent-preset/selected` payload lives in
   * `data.agentPreset`, so the bridge has to reach the persistence layer.
   * `session-log.cjs` reproduces the host's frame-scanning path
   * (multi-frame Zstandard) so this stays a single-process, dependency-
   * free read — no `@deepseek-ai/*` imports.
   *
   * @param sessionId - the durable session id (the same format the GUI
   *   mints via `mintSessionId()`).
   * @param cwd - optional recorded working directory. `/s list` already
   *   has this from the first `listSessions()`; passing it avoids a
   *   second full roster scan per row. When omitted, the roster is
   *   consulted once to recover `header.cwd`.
   * @returns the preset id, or undefined when the session has none on
   *   record (no header value, no switch events, no readable log).
   */
  async resolveSessionPreset(sessionId: string, cwd?: string, header?: SessionHeader): Promise<string | undefined> {
    if (!sessionId) return undefined;
    const facts = await this.readSessionListFacts(sessionId, cwd, header);
    return facts.preset;
  }

  private async sessionLog(): Promise<{
    readSessionRecency: (cwd: string, sessionId: string, root?: string) => number | undefined;
    readSessionListFacts: (cwd: string, sessionId: string, root?: string) => SessionListFacts;
    readSessionRuntimePreset: (cwd: string, sessionId: string, root?: string) => string | undefined;
    readSessionUsedHint: (
      cwd: string,
      sessionId: string,
      root?: string,
    ) => { status: "used"; time?: number } | { status: "blank" } | { status: "unknown" };
  } | undefined> {
    try {
      return await import("./session-log.cjs");
    } catch {
      return undefined;
    }
  }

  /**
   * Walk a live agent's in-memory log newest-first. `found: true` means
   * the session is attached (even when it has no user prompt).
   */
  private liveListFacts(sessionId: string): { found: boolean; facts: SessionListFacts } {
    try {
      const agents = this.get<{
        get(id: string): {
          session?: AgentSession;
        } | undefined;
      }>("agents");
      const session = agents?.get(sessionId)?.session;
      if (!session) return { found: false, facts: {} };
      // A live Session object is not enough: 0.1.5 always has one, but
      // the log is only readable via snapshotEvents() (or the legacy
      // `events` array). Without either, fall through to disk.
      if (typeof session.snapshotEvents !== "function" && !Array.isArray(session.events)) {
        return { found: false, facts: {} };
      }
      const events = sessionEvents(session);
      const facts: SessionListFacts = {};
      if (typeof session?.header?.agentPreset === "string" && session.header.agentPreset.length > 0) {
        facts.preset = session.header.agentPreset;
      }
      for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.type === "agent-preset/selected") {
          const data = ev.data as { agentPreset?: unknown } | undefined;
          if (typeof data?.agentPreset === "string" && data.agentPreset.length > 0) {
            facts.preset = data.agentPreset;
          }
        } else if (ev.type === "session/title") {
          const data = ev.data as { title?: unknown } | undefined;
          if (typeof data?.title === "string" && data.title.length > 0) {
            facts.title = data.title;
          }
        } else if (ev.type === "user/message" && typeof ev.time === "number") {
          const data = ev.data as { source?: { kind?: string } } | undefined;
          const kind = data?.source?.kind;
          if (!kind || kind === "user") facts.lastUserMessageTime = ev.time;
        }
      }
      return { found: true, facts };
    } catch {
      return { found: false, facts: {} };
    }
  }

  /** Zero-I/O listing hint from the host projection cache (same source as the GUI sidebar). */
  private cachedListHint(header: SessionHeader | undefined): SessionListFacts | undefined {
    if (!header) return undefined;
    const cache = this.get<ProjectionCacheService>("sessionProjectionCache");
    if (!cache || typeof cache.cachedSnapshot !== "function") return undefined;
    try {
      const snap = cache.cachedSnapshot(header, 0);
      const values = snap?.values;
      if (!values) return undefined;
      const hint: SessionListFacts = {};
      const meta = values.sessionListMetadata;
      if (meta && typeof meta === "object") {
        const lastPromptAt = (meta as { lastPromptAt?: unknown }).lastPromptAt;
        if (typeof lastPromptAt === "number") hint.lastUserMessageTime = lastPromptAt;
      }
      const title = values.title;
      if (typeof title === "string" && title.length > 0) hint.title = title;
      return hint;
    } catch {
      return undefined;
    }
  }

  /**
   * Read whether a session log is usable and, if so, when the last
   * `user/message` landed. Distinguishes a true blank session (readable,
   * never spoken to) from a corrupt / unreadable log — `/s new` must not
   * treat the latter as "already blank".
   *
   * With `cwd`, `/s new` can skip `listEvents()` for sessions that are
   * obviously used (live log, projection cache, or an artifact larger
   * than a blank header). Full inspect remains the authority for small
   * unknown files and for callers that only have an id.
   */
  async inspectSessionActivity(
    sessionId: string,
    cwd?: string,
    header?: SessionHeader,
  ): Promise<SessionLogActivity> {
    const live = this.liveListFacts(sessionId);
    if (live.found) {
      return { ok: true, lastUserMessageTime: live.facts.lastUserMessageTime };
    }
    const cachedPrompt = this.cachedListHint(header)?.lastUserMessageTime;
    if (cachedPrompt !== undefined) {
      return { ok: true, lastUserMessageTime: cachedPrompt };
    }
    if (typeof cwd === "string" && cwd.length > 0) {
      const runtime = await this.sessionLog();
      if (runtime) {
        try {
          const hint = runtime.readSessionUsedHint(cwd, sessionId, undefined);
          if (hint.status === "used") {
            return { ok: true, lastUserMessageTime: hint.time ?? header?.createdAt ?? 1 };
          }
          if (hint.status === "blank") return { ok: true };
        } catch {
          // fall through to listEvents
        }
      }
    }
    const query = this.get<SessionQuery>("sessionQuery");
    // No query service: we cannot prove corruption. Treat as a readable
    // empty log so `/s new` keeps the historical "already blank" path
    // instead of minting a duplicate session on every command.
    if (!query) return { ok: true };
    try {
      const records = await query.listEvents(sessionId);
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i]!.type === "user/message") {
          return { ok: true, lastUserMessageTime: records[i]!.time };
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Time of the session's last user-prompt event (`user/message`).
   *
   * `/s list` calls this for every visible session on a cold start, so this
   * must not `listEvents()` (that inspects the complete validated log).
   * Prefer the live in-memory log, then the GUI's projection-cache hint,
   * then a newest-first tail read of the raw artifact. `cwd` comes from
   * the roster header; without it we fall back to {@link inspectSessionActivity}.
   */
  async lastUserMessageTime(
    sessionId: string,
    cwd?: string,
    header?: SessionHeader,
  ): Promise<number | undefined> {
    const live = this.liveListFacts(sessionId);
    if (live.found) return live.facts.lastUserMessageTime;
    const cached = this.cachedListHint(header)?.lastUserMessageTime;
    if (cached !== undefined) return cached;
    if (typeof cwd === "string" && cwd.length > 0) {
      const runtime = await this.sessionLog();
      if (!runtime) return undefined;
      try {
        // `undefined` here means "no prompt in the cheap tail" (or blank),
        // not "try the full inspect". `/s list` falls back to createdAt.
        return runtime.readSessionRecency(cwd, sessionId, undefined);
      } catch {
        return undefined;
      }
    }
    const activity = await this.inspectSessionActivity(sessionId);
    return activity.ok ? activity.lastUserMessageTime : undefined;
  }

  /**
   * Title + live preset + recency for one displayed `/s list` row. One
   * raw-log fold replaces a `readTitle` inspect plus a second preset scan.
   */
  async readSessionListFacts(sessionId: string, cwd?: string, header?: SessionHeader): Promise<SessionListFacts> {
    const live = this.liveListFacts(sessionId);
    if (live.found) {
      return {
        ...this.cachedListHint(header),
        ...live.facts,
      };
    }
    const hint = this.cachedListHint(header) ?? {};
    let resolvedCwd = typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
    if (!resolvedCwd) {
      const query = this.get<SessionQuery>("sessionQuery");
      if (query) {
        try {
          resolvedCwd = (await query.listSessions()).find((r) => r.header.id === sessionId)?.header.cwd;
        } catch {
          resolvedCwd = undefined;
        }
      }
    }
    if (!resolvedCwd) return hint;
    const runtime = await this.sessionLog();
    if (!runtime) return hint;
    try {
      const facts = runtime.readSessionListFacts(resolvedCwd, sessionId, undefined);
      return {
        ...hint,
        ...facts,
        lastUserMessageTime: facts.lastUserMessageTime ?? hint.lastUserMessageTime,
        title: facts.title ?? hint.title,
        preset: facts.preset ?? hint.preset,
      };
    } catch {
      return hint;
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
   *  1. Try in-memory `session.snapshotEvents()` (0.1.5) or the legacy
   *     `session.events` array via `ctx.get("agents")` — fast, no I/O,
   *     survives even when `sessionQuery` is unavailable.
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
      const agents = this.get<{ get(id: string): { session?: AgentSession } | undefined }>("agents");
      const agent = agents?.get(sessionId);
      const events = sessionEvents(agent?.session);
      if (events.length > 0) {
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

    // 2) Persisted fallback. Prefer `readSession` (full events with `data`);
    // `listEvents` in 0.1.2 is metadata-only and cannot reconstruct text.
    const query = this.get<SessionQuery>("sessionQuery");
    if (!query) return [];
    try {
      let records: Array<{ type: string; time?: number; data?: unknown }> = [];
      if (typeof query.readSession === "function") {
        const snapshot = await query.readSession(sessionId);
        records = snapshot.events ?? [];
      } else {
        records = await query.listEvents(sessionId);
      }
      const entries: HistoryEntry[] = [];
      for (const r of records) {
        if (r.type !== "user/message" && r.type !== "assistant/message") continue;
        const text = this.extractHistoryText(r.data);
        if (!text) continue;
        const role = r.type === "user/message" ? "user" as const : "assistant" as const;
        entries.push({ role, text, time: typeof r.time === "number" ? r.time : Date.now() });
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

  // ─── Busy-Enter delivery behavior (ui-conversation.busyEnter) ───

  /**
   * The resolved busy-time delivery behavior — the same value the GUI's
   * General Settings 「繁忙时 Enter 键行为」 row shows. Falls back to
   * `"queue"` (the schema default) when no settings provider is mounted,
   * the namespace is unregistered, or the read throws.
   */
  busyEnter(): BusyEnterBehavior {
    const settings = this.get<SettingsService>("settings");
    try {
      const section = settings?.get(BUSY_ENTER_NAMESPACE as SettingsNamespace) as
        | { busyEnter?: unknown }
        | undefined;
      return section?.busyEnter === "steer" ? "steer" : "queue";
    } catch {
      return "queue";
    }
  }

  /**
   * Persist the busy-Enter behavior into the DSH settings document
   * (`ui-conversation` namespace) — the exact field the GUI settings page
   * edits, so a switch from WeChat shows up there and vice versa. Returns
   * false when no settings provider is mounted or the write is refused.
   */
  async saveBusyEnter(next: BusyEnterBehavior): Promise<boolean> {
    const settings = this.get<SettingsService>("settings");
    if (!settings) return false;
    try {
      await settings.update(BUSY_ENTER_NAMESPACE as SettingsNamespace, { busyEnter: next });
      return true;
    } catch (err) {
      console.error(`[dsh-wechat] save busyEnter failed: ${String(err)}`);
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
