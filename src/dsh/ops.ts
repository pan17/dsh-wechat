/**
 * DSH read/write operations behind the WeChat workspace/session/agent/model
 * commands. All service access goes through `ctx.get(...)` with undefined
 * checks — no runtime imports of `@deepseek-ai/*` packages.
 */

import type { Agent, AgentSession, AgentSessionLike, JobsService, SessionProjectionService, TurnBoundaryState } from "./types.js";
import { modelSelectionFromProjection, sessionEvents } from "./types.js";
import type { BridgeContext } from "./sessions.js";

/** Nominal id of one registered settings namespace (dsh-settings brand). */
export type SettingsNamespace = string & { readonly __settingsNamespace?: undefined };

/**
 * Busy-time delivery behavior for user messages (DSH `ui-conversation.busyEnter`).
 * `queue` = ordinary follow-up turn; `steer` = splice into the running turn at
 * the nearest step boundary. The value lives in the host configuration
 * (profile config in DSH 0.2, user-settings document in older hosts) — the exact field the GUI's General Settings
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
  /**
   * Registry-global pin set (dsh-workspace): sessions surfaced ahead of every
   * unpinned session on grouping surfaces. **Most recently pinned first** —
   * this is the host's own array order, not a recency sort. Pinning never
   * touches workspace accounting, and archiving a session drops its pin in
   * the same durable write.
   *
   * Optional: a host older than the pin feature simply omits it, so readers
   * must fall back to "no pinned sessions".
   */
  readonly pinnedSessionIds?: readonly string[];
  /**
   * Pin one session durably, prepending it to the pin set. Idempotent: an
   * already pinned id resolves without writing or reordering. Rejects with
   * `WorkspaceArchivedSessionPinError` (name-matching) for an archived
   * session — pinning and archival are mutually exclusive — and with
   * `WorkspaceUnknownSessionError` for a session that does not exist.
   */
  pinSession?(sessionId: string): Promise<void>;
  /**
   * Drop one session from the pin set. Idempotent and, unlike pinning, runs
   * no session-existence check (removing an id cannot introduce an unknown
   * one), so an entry whose session is gone still resolves.
   */
  unpinSession?(sessionId: string): Promise<void>;
}

/**
 * Result of a pin/unpin attempt, mapped from the host's own outcomes so the
 * bridge can word a precise reply without importing `@deepseek-ai/*` error
 * classes (the host sets `err.name`, which is the stable discriminator).
 *
 * - `ok` — the write landed (or was already in the requested state).
 * - `archived` — `pinSession` refused an archived session.
 * - `unknown` — the host reported no such session.
 * - `unavailable` — no registry, or the host version has no pin API.
 * - `failed` — anything else (storage fault, unexpected rejection).
 */
export type PinOutcome = "ok" | "archived" | "unknown" | "unavailable" | "failed";

export interface SessionQuery {
  listSessions(): Promise<SessionRecord[]>;
  readTitle(sessionId: string): Promise<{ title?: string } | undefined>;
  /** Lightweight raw-log event records (ascending seq), for recency recovery. */
  listEvents(sessionId: string): Promise<Array<{ type: string; time: number; data?: unknown; seq?: number }>>;
  /**
   * Full validated log (0.1.2+). `listEvents` no longer carries `data`, so
   * `/history` and `/fork` both prefer this when the host exposes it. `seq`
   * rides along on every event — it is the coordinate `/fork` cuts at.
   */
  readSession?(sessionId: string): Promise<{
    events: Array<{ type: string; time?: number; data?: unknown; seq?: number }>;
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
  /**
   * DSH 0.1.7+ takes an optional projection-key filter as the second
   * parameter (it is fed to `new Set(keys)`); the pre-0.1.7 signature took an
   * `inheritedEventCount: number`. Passing `0` therefore throws
   * `number 0 is not iterable` on every 0.2.x host, which the caller's
   * try/catch swallowed into a silent loss of the cache hint.
   */
  cachedSnapshot(
    header: SessionHeader,
    keys?: readonly string[],
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

export interface LlmService {
  listProviders(): ProviderInfo[];
  listModels(provider: string): Promise<ModelInfo[]>;
  /** Exact-route metadata: context window, reasoning efforts, etc. */
  resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: ModelReasoningInfo }>;
}

export interface AgentPresetsService {
  list(): Promise<AgentPreset[]>;
  recompose(agentCtx: unknown, id: string): Promise<unknown>;
  /**
   * Preset id mounted when a caller names none (dsh-agent-presets).
   * This is the DEPLOYMENT default — the new-session default, not the bound
   * session's preset.
   */
  defaultId?: string;
  /**
   * The host's own preset switch for a not-yet-started session
   * (`@deepseek-ai/dsh-agent-preset-registry` `select`): it rebinds the live
   * Agent and appends the durable `agent-preset/selected` event, so the
   * switch survives restarts and shows up in `/s list` + `/status`.
   *
   * It refuses a session that has already started (`agent-preset/locked`),
   * which is exactly the constraint `/preset switch` now surfaces instead of
   * silently writing a global default the user did not ask for.
   */
  select?(agent: Agent, agentPreset: string): Promise<string>;
}

export interface AgentDefaultModelService {
  currentSelection(): ModelSelection;
  saveSelection(next: ModelSelection): Promise<void>;
}

/**
 * Minimal structural surface of the Host `sessionController` service
 * (`@deepseek-ai/dsh-api-session-controller`). `selectModel` is the exact
 * Remote operation the GUI model picker calls: it validates the route,
 * appends the durable `model/selection` event, installs the Session-local
 * selection, and saves the deployment default in the background. Calling it
 * from WeChat is what keeps both surfaces on ONE selection instead of the
 * bridge maintaining a second, request-only override.
 *
 * `fork` and `rename` are the two operations behind the GUI chat's
 * 「分叉」 button: `fork` copies the inclusive event prefix through `atSeq`
 * into a brand-new Session (the child gets its own Agent, a `parentSession`
 * header and the source workspace membership), and `rename` rewrites the
 * child's title so parent and child do not read as duplicates.
 */
export interface SessionControllerService {
  selectModel?(request: {
    sessionId: string;
    provider: string;
    model: string;
    reasoningEffort?: string;
  }): Promise<{ selected?: ModelSelection } | undefined>;
  /**
   * Fork one Session at an inclusive event boundary.
   *
   * The GUI passes the closing turn's `turn/end` seq as `atSeq`, and so does
   * `/fork switch`: the cut then contains the whole completed turn. Omitting
   * `atSeq` lets the host pick the latest completed-turn prefix, which is NOT
   * what either surface wants (the user names the turn).
   */
  fork?(request: {
    sessionId: string;
    atSeq?: number;
    allowMigration?: boolean;
  }): Promise<{ sessionId: string } | undefined>;
  /** Append a user-owned Session title (the GUI's rename). */
  rename?(request: {
    sessionId: string;
    title: string;
  }): Promise<{ title?: string; seq?: number } | undefined>;
}

/**
 * One conversation turn, folded from the durable session log exactly the way
 * the host's `turnOutline` projection folds it (`@deepseek-ai/dsh-session-turn-outline`):
 * `turn/start` anchors a turn, the FIRST human `user/message` of that turn is
 * its prompt, and the last text-bearing `assistant/message` becomes its reply
 * when `turn/end` commits the draft.
 *
 * Unlike the projection this carries the FULL text (the projection caps at
 * 50/120-char previews) plus the `turn/end` seq, which is the fork boundary
 * the GUI uses.
 */
export interface SessionTurn {
  /** Host turn number (`turn/start` payload `data.turn`) — the GUI rail's number. */
  turn: number;
  /** Full text of the turn's first human prompt; `''` for an image-only turn. */
  prompt: string;
  /** Full text of the reply committed at `turn/end`; `''` when the turn produced none. */
  reply: string;
  /** `turn/start` seq — the load-through anchor, unused by the bridge today. */
  startSeq: number;
  /**
   * `turn/end` seq — the exact inclusive fork boundary.
   *
   * Absent while the turn is still open: a running turn has no closing event,
   * so there is nothing to cut at and `/fork switch` must refuse it.
   */
  endSeq?: number;
  /**
   * Event time of the human `user/message` that filled the prompt.
   *
   * Kept separate from {@link replyTime}: a turn can run for minutes, and the
   * two sides are printed with their own clock because they answer different
   * questions — "when did I say this" and "when did it answer".
   */
  promptTime?: number;
  /** Event time of `turn/end`; absent while the turn is still open. */
  replyTime?: number;
}

/**
 * Outcome of a fork attempt, mapped from the host's own error codes so the
 * bridge can word a precise reply without importing `@deepseek-ai/*` classes
 * (the host's `RemoteError` carries a stable `code` string).
 */
export type ForkOutcome =
  | { kind: "ok"; sessionId: string }
  /** The deployment composes no session controller, or one without `fork`. */
  | { kind: "unsupported" }
  /** `session/not-found` — the source Session is gone. */
  | { kind: "not-found" }
  /** `session/fork-unavailable` — the cut seq is not in the source log. */
  | { kind: "unavailable"; message: string }
  /** `session/migration-required` — the source log needs an open in the GUI first. */
  | { kind: "migration-required" }
  | { kind: "error"; message: string };

/** Outcome of routing one switch through the Host session controller. */
export type SessionModelSelectionOutcome =
  | { kind: "host" }
  /** The deployment composes no session controller (older Host / headless). */
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

/**
 * Outcome of switching one session's agent preset (`/preset switch`).
 *
 * `locked` is the interesting failure: DSH refuses to change a preset once the
 * session has started a turn, and the bridge reports that as "start a new
 * session first" rather than papering over it with a global default write.
 */
export type SessionPresetOutcome =
  | { kind: "switched" }
  /** Host exposes neither `select` nor `recompose` for presets. */
  | { kind: "unsupported" }
  /** The session already ran a turn — `agent-preset/locked`. */
  | { kind: "locked" }
  | { kind: "error"; message: string };

/** Minimal structural surface of the `permissionPresets` service (dsh-permission-presets). */
export interface PermissionPresetsService {
  /** Advertised preset names, in table declaration order. */
  readonly names: readonly string[];
  /** Preset selected as the default for future sessions (settings-first). */
  readonly defaultPreset: string;
  /**
   * Effective preset for one session, or `custom` when nothing matches.
   * The host folds `sessionProjections.stateOf(session, "permissions")`
   * (host signature `current(session: Session): string`, since
   * dsh 0.1.2-alpha.2), so this face takes the live Session — an event
   * array makes the host throw `permission: permissions session
   * projection is not registered`.
   */
  current(session: unknown): string;
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
 * Host settings across versions: DSH 0.2 projects live plugin Config values
 * through describe(); older hosts expose get(ns). update(ns, patch) remains
 * the shared write entry point used by the GUI.
 */
export interface SettingsService {
  get?(ns: SettingsNamespace): unknown;
  describe?(): readonly { ns: string; value?: unknown }[];
  update(ns: SettingsNamespace, patch: object): Promise<void>;
}

/** One session-reference discovery candidate (dsh-session-reference). */
export interface SessionReferenceCandidate {
  readonly sessionId: string;
  /** Mention label: the session's latest title, or its id when untitled. */
  readonly label: string;
  /** Presentation title (a subagent's durable creation label wins). */
  readonly displayTitle?: string;
  readonly cwd?: string;
  /** True when the candidate shares the requesting agent's working directory. */
  readonly sameWorkspace?: boolean;
  readonly createdAt?: number;
}

/**
 * Minimal structural surface of `ctx.sessionReferenceResolver`
 * (`@deepseek-ai/dsh-session-reference`). Only discovery is consumed:
 * preparation is the HOST's job at `agent/pre-step`, driven purely by the
 * canonical mention the bridge stages in the message text. `prepare` is
 * deliberately not called — invoking it out of band would prepare a snapshot
 * the host never attaches to a message.
 */
export interface SessionReferenceResolverService {
  listCandidates(
    agent: Agent,
    query?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<readonly SessionReferenceCandidate[]>;
}

/** One file-reference candidate (`ctx.fileReferences.list`). */
export interface FileReferenceCandidate {
  /** Workspace-relative path; directories carry no trailing slash here. */
  readonly path: string;
  readonly kind: "file" | "directory";
}

/**
 * Minimal structural surface of `ctx.fileReferences`
 * (`@deepseek-ai/dsh-file-reference`). Used by `/at f` only to suggest
 * near-matches for a path that does not exist.
 */
export interface FileReferencesService {
  list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly FileReferenceCandidate[]>;
}

/**
 * One skill as the host reports it. Only the fields `/skill` renders are
 * declared: the registry returns more (`provider`, `source`, `rank`) and this
 * bridge must not depend on any of them.
 *
 * `whenToUse` is deliberately NOT declared even though `SkillSummary` has it:
 * no skill in practice sets it (every SKILL.md here carries only `name` and
 * `description`), so rendering it would be a branch nothing ever reaches.
 *
 * Two host services report invocation policy in two different shapes, so both
 * are declared rather than one being assumed: `ctx.skills.list` nests it under
 * `invocation`, while `ctx.sessionSkillCatalog.list` returns a flat
 * `modelInvocable` (it only ever yields skills a user may invoke, so it has no
 * user flag to report).
 */
export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  /** Absolute path of the skill file, when the provider knows one. */
  readonly path?: string;
  /** Invocation policy, as `ctx.skills.list` reports it. */
  readonly invocation?: {
    readonly modelInvocable?: boolean;
    readonly userInvocable?: boolean;
  };
  /** Invocation policy, as `ctx.sessionSkillCatalog.list` reports it. */
  readonly modelInvocable?: boolean;
}

/**
 * Minimal structural surface of `ctx.skills` (`@deepseek-ai/dsh-skill`), used
 * only for its `list` read.
 *
 * `/skill` never loads a body: executing a skill is the host's job, triggered
 * by writing `/技能名` into the message (see `parseSkillCommand`). So this
 * declares `list` alone — a `get` here would only invite the bridge to start
 * rendering `<skill_content>` itself again.
 *
 * `scope` is the host's `ScopeKey` (`object`); the bridge passes the bound
 * agent so the read merges that preset's layers.
 */
export interface SkillsService {
  list(options?: {
    readonly cwd?: string;
    readonly scope?: object;
    readonly signal?: AbortSignal;
  }): Promise<readonly SkillEntry[]>;
}

/**
 * Minimal structural surface of `ctx.sessionSkillCatalog`: the service behind
 * the GUI's `/` skill completion. Preferred over `ctx.skills` because it
 * resolves the session's cwd AND preset from the durable session record, so it
 * answers for a cold session without resuming an agent.
 */
export interface SessionSkillCatalogService {
  list(
    request: { readonly sessionId: string },
    signal: AbortSignal,
  ): Promise<{ readonly skills: readonly SkillEntry[] }>;
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

  /**
   * Sessions pinned on every grouping surface (dsh-workspace pin set), in the
   * host's own order — most recently pinned first. Empty when the registry is
   * absent or the host version predates the pin feature.
   */
  pinnedSessionIds(): readonly string[] {
    try {
      return this.get<WorkspaceRegistry>("workspaceRegistry")?.pinnedSessionIds ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Whether this host exposes the durable pin API at all. Callers need it to
   * avoid reading an *absent* pin set as "nothing is pinned" — on an older
   * host that reading is indistinguishable from a genuinely empty set, so
   * `/s unpin` would otherwise claim a session is not pinned instead of
   * reporting that the service is missing.
   */
  supportsPin(): boolean {
    const registry = this.get<WorkspaceRegistry>("workspaceRegistry");
    return typeof registry?.pinSession === "function" && typeof registry?.unpinSession === "function";
  }

  /**
   * Pin one session through the host registry, so the GUI sidebar and WeChat
   * read one durable set. Never throws: the outcome is mapped for the caller's
   * wording (see {@link PinOutcome}).
   */
  async pinSession(sessionId: string): Promise<PinOutcome> {
    return this.writePin("pinSession", sessionId);
  }

  /**
   * Unpin one session through the host registry. Idempotent, and the host runs
   * no existence check here — an id that is not pinned simply resolves.
   */
  async unpinSession(sessionId: string): Promise<PinOutcome> {
    return this.writePin("unpinSession", sessionId);
  }

  /**
   * Shared body of {@link pinSession} / {@link unpinSession}: resolve the
   * registry, refuse when this host exposes no such method, then classify the
   * rejection by `err.name` (the host's stable discriminator, which avoids a
   * runtime `@deepseek-ai/*` import).
   */
  private async writePin(
    method: "pinSession" | "unpinSession",
    sessionId: string,
  ): Promise<PinOutcome> {
    if (!sessionId) return "unknown";
    const registry = this.get<WorkspaceRegistry>("workspaceRegistry");
    if (!registry) return "unavailable";
    const write = registry[method];
    if (typeof write !== "function") return "unavailable";
    try {
      await write.call(registry, sessionId);
      return "ok";
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "WorkspaceArchivedSessionPinError") return "archived";
      if (name === "WorkspaceUnknownSessionError") return "unknown";
      return "failed";
    }
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
      const snap = cache.cachedSnapshot(header);
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
          const hint = runtime.readSessionUsedHint(cwd, sessionId, this.get<{ home?: string }>("homePaths")?.home);
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
        return runtime.readSessionRecency(cwd, sessionId, this.get<{ home?: string }>("homePaths")?.home);
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
      const facts = runtime.readSessionListFacts(resolvedCwd, sessionId, this.get<{ home?: string }>("homePaths")?.home);
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

  // ─── Turns & fork ─────────────────────────────────────────────────────────

  /**
   * Classify one `user/message` payload as a genuine human turn or a
   * synthesized system injection.
   *
   * The host attributes synthesized user-role messages through
   * `source.kind` — `plugin` (context injections / compaction
   * checkpoints), `goal` (goal rounds), `session-reference` (recalls),
   * `agent-message` (relays). The GUI sidebar lists only `kind === "user"`
   * (session-turn-outline). Legacy payloads without a source stay human
   * so nothing real is hidden. Nested `data.message.source` is accepted
   * alongside the host's flat `data.source`.
   */
  private userMessageRole(data: unknown): "user" | "system" {
    if (!data || typeof data !== "object") return "user";
    const d = data as Record<string, unknown>;
    const direct = (d.source as { kind?: unknown } | undefined)?.kind;
    const nested = ((d.message as Record<string, unknown> | undefined)?.source as { kind?: unknown } | undefined)?.kind;
    const kind = direct ?? nested;
    return kind === undefined || kind === "user" ? "user" : "system";
  }

  // ─── Turns & fork ─────────────────────────────────────────────────────────

  /**
   * Read one session's durable log as event records that carry `seq`.
   *
   * Two sources, in this order: the live in-memory log first (no I/O, and the
   * bound session is normally live), then the persisted
   * `sessionQuery.readSession()` read (full validated events with `data`).
   * `listEvents` is deliberately NOT a fallback — since 0.1.2 it is
   * metadata-only and cannot reconstruct prompt/reply text, so folding it
   * would silently produce empty turns.
   *
   * Returns `[]` on any error; callers render a friendly empty state.
   */
  private async sessionLogRecords(
    sessionId: string,
  ): Promise<Array<{ type: string; time?: number; data?: unknown; seq?: number }>> {
    try {
      const agents = this.get<{ get(id: string): { session?: AgentSession } | undefined }>("agents");
      const events = sessionEvents(agents?.get(sessionId)?.session);
      if (events.length > 0) return [...events];
    } catch {
      // fall through to persisted path
    }
    const query = this.get<SessionQuery>("sessionQuery");
    if (!query || typeof query.readSession !== "function") return [];
    try {
      const snapshot = await query.readSession(sessionId);
      return snapshot.events ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Text of one message event, mirroring the host's own extraction shape:
   * `assistant/message` nests the message under `data.message`, while
   * `user/message` carries it directly in `data`.
   *
   * Text blocks are joined with a newline in block order and left otherwise
   * untouched — the turn fold needs the full, unnormalized body so `/fork show`
   * and `/history show` can print it verbatim.
   */
  private turnMessageText(data: unknown, nested: boolean): string {
    if (!data || typeof data !== "object") return "";
    const holder = nested ? (data as { message?: unknown }).message : data;
    if (!holder || typeof holder !== "object") return "";
    const content = (holder as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    const parts = content
      .filter(
        (block): block is { type: string; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text);
    return parts.join("\n");
  }

  /**
   * Fold a log into turns, exactly as the host's `turnOutline` projection
   * folds it — with full text and the closing seq attached.
   *
   * The rules, copied from `@deepseek-ai/dsh-session-turn-outline`:
   *   - `turn/start` anchors a turn, but only when its `data.turn` ADVANCES
   *     past the previous entry (a retried boundary reuses the number and
   *     must not create a second row);
   *   - the turn's FIRST human `user/message` fills the prompt, and later
   *     human messages in the same turn (steering) never overwrite it;
   *   - every text-bearing `assistant/message` overwrites a draft;
   *   - `turn/end` commits the draft as the reply and records its own seq,
   *     which is the exact inclusive fork boundary.
   *
   * Synthesized user-role messages (compaction checkpoints, plugin context,
   * goal rounds — see {@link userMessageRole}) never become a prompt.
   */
  private turnEntries(
    events: readonly { type: string; time?: number; data?: unknown; seq?: number }[],
  ): SessionTurn[] {
    const turns: SessionTurn[] = [];
    let draft = "";
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      switch (event.type) {
        case "turn/start": {
          const turn = (event.data as { turn?: unknown } | undefined)?.turn;
          if (typeof turn !== "number") break;
          // `seq` is the load-through anchor and the coordinate space the fork
          // boundary lives in; without it the turn cannot be addressed at all.
          if (typeof event.seq !== "number") break;
          const last = turns.at(-1);
          if (last !== undefined && turn <= last.turn) break;
          turns.push({
            turn,
            prompt: "",
            reply: "",
            startSeq: event.seq,
          });
          draft = "";
          break;
        }
        case "user/message": {
          const last = turns.at(-1);
          if (last === undefined || last.prompt !== "") break;
          if (this.userMessageRole(event.data) !== "user") break;
          const prompt = this.turnMessageText(event.data, false).trim();
          if (!prompt) break;
          // The prompt's own clock, not the turn's: this message is when the
          // human spoke, which can be minutes before the turn closes.
          turns[turns.length - 1] = {
            ...last,
            prompt,
            ...(typeof event.time === "number" ? { promptTime: event.time } : {}),
          };
          break;
        }
        case "assistant/message": {
          const reply = this.turnMessageText(event.data, true).trim();
          if (!reply) break;
          draft = reply;
          break;
        }
        case "turn/end": {
          const last = turns.at(-1);
          if (last === undefined) {
            draft = "";
            break;
          }
          // A closing event names its turn; ignore one that does not match the
          // row we are folding (defensive: a malformed log must not move a
          // completed turn's boundary onto the wrong row).
          const closingTurn = (event.data as { turn?: unknown } | undefined)?.turn;
          if (typeof closingTurn === "number" && closingTurn !== last.turn) {
            draft = "";
            break;
          }
          turns[turns.length - 1] = {
            ...last,
            ...(draft === "" ? {} : { reply: draft }),
            ...(typeof event.seq === "number" ? { endSeq: event.seq } : {}),
            // The reply's clock is the closing event, which is when the answer
            // was committed — not the prompt's time, which `...last` carries.
            ...(typeof event.time === "number" ? { replyTime: event.time } : {}),
          };
          draft = "";
          break;
        }
        default:
          break;
      }
    }
    return turns;
  }

  /**
   * Every turn of one session, oldest first, with full prompt/reply text and
   * the closing seq `/fork switch` cuts at.
   *
   * A turn whose `endSeq` is absent is still running (or was interrupted
   * before its closing event reached the log) — it is listed, but cannot be
   * forked from.
   */
  async readSessionTurns(sessionId: string): Promise<SessionTurn[]> {
    if (!sessionId) return [];
    try {
      return this.turnEntries(await this.sessionLogRecords(sessionId));
    } catch {
      return [];
    }
  }

  /** Whether this deployment exposes the host's fork operation at all. */
  supportsFork(): boolean {
    return typeof this.get<SessionControllerService>("sessionController")?.fork === "function";
  }

  /**
   * Fork one session at an inclusive event boundary through the Host session
   * controller — the exact call the GUI chat's 「分叉」 button makes, so the
   * child is a first-class session (own Agent, `parentSession` header, same
   * workspace membership) rather than a bridge-side imitation.
   *
   * Never throws: the host's error codes are mapped to {@link ForkOutcome} so
   * the caller can word the failure.
   */
  async forkSession(sessionId: string, atSeq: number): Promise<ForkOutcome> {
    const controller = this.get<SessionControllerService>("sessionController");
    if (!controller || typeof controller.fork !== "function") return { kind: "unsupported" };
    try {
      const result = await controller.fork({ sessionId, atSeq });
      const childId = result?.sessionId;
      if (typeof childId !== "string" || childId.length === 0) {
        return { kind: "error", message: "宿主没有返回新会话 id" };
      }
      return { kind: "ok", sessionId: childId };
    } catch (err) {
      const code = (err as { code?: unknown } | undefined)?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === "session/not-found") return { kind: "not-found" };
      if (code === "session/fork-unavailable") return { kind: "unavailable", message };
      if (code === "session/migration-required") return { kind: "migration-required" };
      return { kind: "error", message };
    }
  }

  /**
   * Append one user-owned session title (the GUI's rename). Returns whether
   * the write landed; a failure is never fatal — the forked child is usable
   * with its inherited title, it just reads as a duplicate of its parent.
   */
  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const controller = this.get<SessionControllerService>("sessionController");
    if (!controller || typeof controller.rename !== "function") return false;
    try {
      await controller.rename({ sessionId, title });
      return true;
    } catch {
      return false;
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

  /**
   * The Session's host-owned model selection, folded from the
   * `modelSelection` projection (`next` = the durable selection the next
   * request should use, `lastUsed` = the selection consumed by the latest
   * request). This is the same pair the GUI picker reads, so `/status` and
   * `/reasoning status` stay truthful after either surface switches.
   * Returns `undefined` when the projection registry is not composed or
   * the Session has no recorded selection yet.
   */
  sessionModelSelection(session: AgentSessionLike | undefined): ModelSelection | undefined {
    if (!session) return undefined;
    try {
      const snapshot = this.sessionProjections()?.snapshot(session);
      const selected = modelSelectionFromProjection(snapshot?.values?.["modelSelection"]);
      return selected?.provider && selected.model
        ? {
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the Host owns per-Session model selection — the `sessionController`
   * Remote the GUI model picker rides on. DSH 0.2.2 fixes each step's
   * provider/model/reasoning effort BEFORE the `agent/request` waterfall and
   * throws when a listener returns a different one, so the legacy in-memory
   * override must be neither written nor applied on such a host: the durable
   * `model/selection` is the only route source.
   */
  hostOwnsModelSelection(): boolean {
    const controller = this.get<SessionControllerService>("sessionController");
    return typeof controller?.selectModel === "function";
  }

  /**
   * Route one model/effort switch through the Host session controller — the
   * same `session.selectModel` Remote the GUI picker submits. On success the
   * Host records `model/selection`, installs the selection for the next
   * prompt assembly, and updates the default, so the GUI and WeChat see the
   * same value immediately (and a later GUI switch simply replaces it).
   *
   * Older hosts or minimal profiles without that service report
   * `unsupported`; the caller keeps the legacy in-memory override path.
   * A controller rejection is reported as `error` rather than silently
   * falling back, matching the GUI's "unavailable model" behavior.
   */
  async selectSessionModel(
    sessionId: string,
    selection: ModelSelection,
  ): Promise<SessionModelSelectionOutcome> {
    const controller = this.get<SessionControllerService>("sessionController");
    if (!controller || typeof controller.selectModel !== "function") {
      return { kind: "unsupported" };
    }
    try {
      await controller.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort !== undefined
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      });
      return { kind: "host" };
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
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
   * Persist the deployment-wide default preset — the exact selection the GUI
   * settings page edits, so a change from WeChat shows up there and vice versa.
   * Returns false when no settings provider is mounted or the write is refused.
   *
   * DSH 0.2 exposes `agent-preset-registry.selectedDefault` as a live settings
   * field and removed `settings.get`; the ordinary `default` config is only the
   * deployment fallback, and older hosts use `agent-presets.default` instead.
   * The config-row id IS the settings namespace (`settings.update` resolves it
   * against the profile's loader entries and throws `No configurable plugin
   * entry` otherwise), so a describe-capable host must advertise the entry
   * before we write; the legacy pair stays as the older-host path.
   */
  async saveDefaultPreset(presetId: string): Promise<boolean> {
    const settings = this.get<{
      describe?(): readonly { ns: string }[];
      update(ns: SettingsNamespace, patch: object): Promise<void>;
    }>("settings");
    if (!settings) return false;
    try {
      const descriptors = settings.describe?.();
      const registry = descriptors?.find((row) => row.ns === "agent-preset-registry")
        ?? descriptors?.find((row) => row.ns.endsWith(":agent-preset-registry"));
      if (registry) {
        await settings.update(registry.ns as SettingsNamespace, { selectedDefault: presetId });
      } else {
        const legacy = descriptors?.find((row) => row.ns === "agent-presets");
        // A describe-capable host must advertise the entry before we write.
        if (descriptors && !legacy) return false;
        await settings.update((legacy?.ns ?? "agent-presets") as SettingsNamespace, { default: presetId });
      }
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

  /**
   * Whether a session is still "not started" — the one state in which DSH lets
   * its agent preset change. Mirrors the host predicate exactly
   * (`agent-presets.select` reads the `turnBoundary` projection and refuses
   * when a turn is open or a turn has already completed), falling back to a log
   * fold on hosts that predate the projection.
   */
  sessionStarted(session: AgentSessionLike | undefined): boolean {
    if (!session) return false;
    const projections = this.sessionProjections();
    try {
      const boundary = projections?.stateOf?.(session, "turnBoundary") as TurnBoundaryState | undefined;
      if (boundary && typeof boundary === "object") {
        return boundary.openTurnStartSeq != null || (boundary.lastTurn ?? 0) > 0;
      }
    } catch {
      // fall through to the log fold
    }
    return sessionEvents(session as AgentSession).some(
      (ev) =>
        ev?.type === "turn/start" ||
        ev?.type === "user/message" ||
        ev?.type === "assistant/message",
    );
  }

  /**
   * Switch the preset of a session that has not started yet — the host's own
   * `agentPresets.select`, which rebinds the live Agent AND appends the durable
   * `agent-preset/selected` event (so the switch survives a resume and shows up
   * in `/s list` / `/status`).
   *
   * This is deliberately NOT `saveDefaultPreset`: `/preset switch` is a
   * session-scoped action, and writing the deployment default instead would
   * change every future session of this DSH install on the strength of one
   * chat message.
   */
  async selectSessionPreset(agent: Agent, presetId: string): Promise<SessionPresetOutcome> {
    const presets = this.get<AgentPresetsService>("agentPresets");
    if (!presets) return { kind: "unsupported" };
    try {
      if (typeof presets.select === "function") {
        await presets.select(agent, presetId);
        return { kind: "switched" };
      }
      // Host without `select`: rebind, then record the same durable event so a
      // later resume mounts this preset and the display paths agree.
      if (typeof presets.recompose !== "function") return { kind: "unsupported" };
      await presets.recompose(agent.ctx, presetId);
      agent.session?.append?.("agent-preset/selected", { agentPreset: presetId });
      return { kind: "switched" };
    } catch (err) {
      if ((err as { code?: unknown } | undefined)?.code === "agent-preset/locked") {
        return { kind: "locked" };
      }
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
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

  // ─── Background jobs ───

  /**
   * The `ctx.jobs` background job registry (the `job_list` family's backing
   * service). Returns `undefined` when the registry is not composed — a
   * minimal headless profile has no jobs at all — and the caller then omits
   * the `[后台任务]` block entirely rather than printing "未挂载".
   *
   * Reads are owner-fenced host-side: `list(caller)` yields the caller's jobs
   * plus unowned ones, so `/status` passing the bound session id is already
   * scoped to that session; other sessions' jobs are unreachable by design.
   */
  jobs(): JobsService | undefined {
    return this.get<JobsService>("jobs");
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
      // Read the resolved live value, not the sparse user override. In DSH
      // 0.2 settings.get was removed when settings moved into profile Config.
      const section = (typeof settings?.describe === "function"
        ? settings.describe().find((row) => row.ns === BUSY_ENTER_NAMESPACE)?.value
        : settings?.get?.(BUSY_ENTER_NAMESPACE as SettingsNamespace)) as
        | { busyEnter?: unknown }
        | undefined;
      return section?.busyEnter === "steer" ? "steer" : "queue";
    } catch {
      return "queue";
    }
  }

  /**
   * Persist the busy-Enter behavior through the DSH settings service
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

  // ─── References (`/at`) ───

  /**
   * The `ctx.sessionReferenceResolver` service (`@deepseek-ai/dsh-session-
   * reference`), or `undefined` when the host does not compose it.
   *
   * `/at s` needs two things from it: `listCandidates` for discovery and —
   * more importantly — the guarantee that the mention this bridge stages will
   * be accepted at `agent/pre-step`. The service is the ONLY consumer of
   * `dsh-session:` mentions, so its absence means a staged session mention
   * would be forwarded as literal text and never expanded: the caller must
   * refuse instead of silently degrading.
   */
  sessionReferenceResolver(): SessionReferenceResolverService | undefined {
    return this.get<SessionReferenceResolverService>("sessionReferenceResolver");
  }

  /**
   * The `ctx.fileReferences` discovery seam
   * (`@deepseek-ai/dsh-file-reference`), or `undefined` when uncomposed.
   *
   * `/at f` does not NEED it (a path is valid prompt text on its own — the
   * provider's job is the model-facing prompt section, which is installed by
   * whoever mounts the provider). It is used only to suggest near-matches
   * when the typed path does not exist, so its absence degrades the hint,
   * never the command.
   */
  fileReferences(): FileReferencesService | undefined {
    return this.get<FileReferencesService>("fileReferences");
  }

  // ─── Skills (`/skill`) ───

  /**
   * The `ctx.skills` registry, or `undefined` when the host composes no skill
   * support. Its absence is a hard "this host has no skills" — `/skill` says so
   * plainly instead of pretending the session has none.
   */
  skills(): SkillsService | undefined {
    return this.get<SkillsService>("skills");
  }

  /**
   * The `ctx.sessionSkillCatalog` service, or `undefined` on hosts that do not
   * expose the skill Remote.
   */
  sessionSkillCatalog(): SessionSkillCatalogService | undefined {
    return this.get<SessionSkillCatalogService>("sessionSkillCatalog");
  }

  /**
   * The skills visible to one session.
   *
   * Two paths, in order, because they answer slightly different questions:
   *
   *   1. `ctx.sessionSkillCatalog.list({sessionId})` — the exact view the GUI's
   *      `/` completion shows for that session (its cwd AND preset decide the
   *      layers), and it never activates a cold agent. Listing skills must not
   *      resume a session.
   *   2. `ctx.skills.list({cwd, scope})` — the same registry read directly,
   *      used when the catalog service is absent (older hosts) or when the
   *      session cannot be inspected.
   *
   * Never throws: a failing provider is logged and treated as "no skills", so
   * `/skill` still answers instead of raising.
   */
  async sessionSkills(
    sessionId: string | undefined,
    options: { cwd?: string; agent?: Agent; signal?: AbortSignal } = {},
  ): Promise<readonly SkillEntry[]> {
    const catalog = this.get<SessionSkillCatalogService>("sessionSkillCatalog");
    if (catalog && sessionId) {
      try {
        const value = await catalog.list({ sessionId }, options.signal ?? new AbortController().signal);
        if (Array.isArray(value?.skills)) return value.skills;
      } catch (err) {
        console.warn(`[dsh-wechat] sessionSkillCatalog.list failed: ${String(err)}`);
      }
    }
    const registry = this.skills();
    if (!registry) return [];
    try {
      return await registry.list({
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.agent ? { scope: options.agent } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      console.warn(`[dsh-wechat] skills.list failed: ${String(err)}`);
      return [];
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
