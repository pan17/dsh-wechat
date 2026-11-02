/**
 * Structural types for the DSH service surface this bridge touches.
 *
 * Deliberately local and minimal: the bridge runs as a third-party static
 * plugin and must not import `@deepseek-ai/*` packages at runtime (they are
 * not resolvable from the profile's node_modules). These shapes mirror the
 * documented contracts verified against the running harness.
 */

/** One model-facing text block. */
export interface TextBlock {
  type: "text";
  text: string;
}

export type ContentBlock = TextBlock;

/** Read-only output shapes; unknown content types are ignored by the bridge. */
export interface OutputContentBlock {
  type: string;
  text?: string;
}

/** Process-local stream contract, projected to the fields used for the prose boundary. */
export type AssistantStreamFrame = {
  type: "start"; attemptId: string; revision: number; turn: number; step: number;
} | {
  type: "chunk"; attemptId: string; revision: number; index: number; time: number;
  chunk: { type: string; index?: number; text?: string; blockType?: string; block?: OutputContentBlock };
} | {
  type: "end"; attemptId: string; revision: number; index: number;
  outcome: { kind: "committed"; eventType: "assistant/message" | "assistant/attempt"; seq: number } | { kind: "abandoned" };
};

export interface ToolCallData {
  callId?: string;
  name?: string;
  arguments?: string;
}

export interface ToolResultData {
  message?: {
    toolCallId?: string;
    isError?: boolean;
    content?: OutputContentBlock[];
  };
  error?: { name?: string; code?: string; reason?: string };
}

/**
 * Message source: `{ kind: 'user' }` (identical to GUI chat-box messages)
 * or `{ kind: 'plugin', plugin }` for synthetic context. WeChat user
 * messages use 'user' so the GUI renders them as ordinary user messages.
 */
export type UserMessageSource = { kind: "user" } | { kind: "plugin"; plugin: string };

/** A user-role message, as produced by `createUserMessage` (dsh-llm). */
export interface UserMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: ContentBlock[];
  readonly source: UserMessageSource;
}

/**
 * One durable session-log record the bridge folds (permission / history / blank).
 *
 * `seq` is the event's position in the log — contiguous from zero, and the
 * exact value the host's fork boundary (`atSeq`) is expressed in. Every
 * durable read carries it (`Session.snapshotEvents()`, `sessionQuery
 * .readSession()`); it stays optional here because the bridge also folds
 * `listEvents()` records, whose shape predates it, and older hosts may omit it.
 */
export interface SessionEventRecord {
  type: string;
  time?: number;
  data?: unknown;
  seq?: number;
}

/**
 * Live session surface used by the bridge.
 *
 * DSH 0.1.5 publishes `snapshotEvents()` as the public log read. Older
 * hosts still expose `events`; both are accepted.
 */
export interface AgentSession {
  /**
   * Durable creation metadata: the recorded agent preset, if any, and the
   * working directory the session was created with (`SessionHeader.cwd`).
   * `cwd` is what the `send_wechat` file bound is evaluated against, so the
   * field is declared here rather than reached for through a cast.
   */
  header?: { id?: string; agentPreset?: string; cwd?: string };
  /** Legacy in-memory log (pre-0.1.5). Prefer {@link snapshotEvents}. */
  events?: readonly SessionEventRecord[];
  /**
   * Public 0.1.5+ snapshot of a half-open event range. Omitted bounds
   * return the full current log.
   */
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly SessionEventRecord[];
  requestHeader?: () =>
    | {
        config?: { provider?: string; model?: string; reasoningEffort?: string };
      }
    | undefined;
  /**
   * Append one durable event to the live log (host `Session.append`). Used to
   * record `agent-preset/selected` on hosts whose preset service has no
   * `select` yet, so the switch still survives a resume.
   */
  append?(type: string, data: unknown): void;
}

/**
 * Read the live session log. Prefers `snapshotEvents()` (DSH 0.1.5);
 * falls back to the legacy `events` array when that is all the host
 * exposes.
 */
export function sessionEvents(session: AgentSession | undefined): readonly SessionEventRecord[] {
  if (!session) return [];
  if (typeof session.snapshotEvents === "function") {
    try {
      const snap = session.snapshotEvents();
      if (Array.isArray(snap)) return snap;
    } catch {
      // fall through to the legacy array
    }
  }
  return Array.isArray(session.events) ? session.events : [];
}

/** Minimal live-agent surface used by the bridge. */
export interface Agent {
  readonly id: string;
  readonly status: "idle" | "running";
  readonly options: { provider?: string; model?: string };
  /** Session header access: the latest logged request config (dsh-session). */
  session?: AgentSession;
  /**
   * The Agent's scoped Cordis context. Preset operations (`mount`,
   * `recompose`, `serviceFor`) are addressed to it — the host's
   * `agentPresets.recompose(ctx, id)` takes exactly this.
   */
  ctx?: unknown;
  followup(message: UserMessage): void;
  steer(message: UserMessage): void;
  /**
   * Cancel the running turn. DSH 0.2.x validates the cause at runtime
   * (`abortedCancelCause` ends in `assertNever`), so the object union is
   * required — the pre-0.2 `"user-stop"` string now throws
   * `unreachable variant` from the agent loop.
   */
  cancel(
    cause: { kind: "user" } | { kind: "parent" } | { kind: "hook"; reason: string } | { kind: "disposed" },
    options?: { keepInbox?: boolean },
  ): void;
  whenIdle(): Promise<void>;
  /**
   * Run a non-turn maintenance operation only while the agent is idle. Used by
   * commands like `/compact` whose handler needs to mutate the surface outside
   * a turn (the DSH `commands.execute` path forwards the receiving agent to
   * `ManualCompactAgentContext.runMaintenance`, which goes through this method).
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface AgentHandle {
  agent: Agent;
}

/** CreateAgentOptions (dsh-agent). */
export interface CreateAgentOptions {
  readonly sessionId: string;
  readonly meta?: {
    readonly cwd?: string;
    readonly agentPreset?: string;
  };
  readonly agentOptions?: {
    provider?: string;
    model?: string;
  };
  /**
   * DSH 0.1.5+ calls `setup(agentCtx, agent)`. The explicit Agent is
   * required because `ctx.agent` was removed; older hosts still invoke
   * with only the context.
   */
  readonly setup?: (agentCtx: unknown, agent?: Agent) => void | Promise<void>;
}

/** ResumeAgentOptions (dsh-agent). */
export interface ResumeAgentOptions {
  readonly resumeSessionId: string;
  readonly agentOptions?: {
    provider?: string;
    model?: string;
  };
  readonly setup?: (agentCtx: unknown, agent?: Agent) => void | Promise<void>;
}

/** ApprovalRequest (dsh-user-approval). */
export interface ApprovalRequest {
  readonly agent: Agent;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** AskUserQuestionItem (dsh-user-questions). */
export interface AskUserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  /** Host intent, e.g. plan-mode `{ kind: "plan-review", approve: "Approve" }`. */
  intent?: { kind?: string; approve?: string };
}

export interface AskUserQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[];
}

export interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[];
  agent?: Agent;
  signal?: AbortSignal;
}

export interface UserQuestionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>;
}

// ─── Session projection registry (ctx.sessionProjections) ───
//
// `ctx.sessionProjections` is the host service through which every DSH
// domain plugin publishes its current per-session state: plan mode
// (`key: 'plan'`), goal (`key: 'goal'`), and any future mode any third-
// party plugin registers. The registry exposes a generic read face
// `snapshot(session)` returning `Record<string, unknown>` over every key
// that was registered for this session — WeChat's `/status` consumes
// this surface exactly once and renders the whole map, so a profile that
// adds new plugins automatically lights up new rows in WeChat with no
// bridge change.

/**
 * Whole-value projection snapshot returned by
 * `ctx.sessionProjections.snapshot(session)` (`@deepseek-ai/dsh-session-projection`).
 *
 * `values` is a `Record<string, unknown>` keyed by every domain key a
 * plugin registered for this session; the runtime shape of each value
 * is whatever the registering plugin's `view` function returned. DSH
 * wires schema validation on the host side, so a value that arrives
 * here is already schema-clean.
 *
 * `asOfSeq` is the watermark of the log position the snapshot
 * reflects — `-1` for an empty log (mirrors `session/subscribed.lastSeq`).
 * The bridge currently does not consume the watermark; it is exposed
 * in the structural surface so a future read face (e.g. a "stale?" UI
 * badge) can reach it without a service-surface widening.
 */
export interface ProjectionSnapshotSurface {
  asOfSeq: number;
  values: Record<string, unknown>;
}

/**
 * Structural surface of `ctx.sessionProjections`.
 *
 * `snapshot` is what `/status` needs (the whole values map). `stateOf` is the
 * single-key read the host itself uses for one projection value — the preset
 * switch needs `turnBoundary` to answer "has this session started?", which is
 * the exact predicate the host's own `agentPresets.select` enforces. Both are
 * optional-shaped (declared, not required) so an older host without
 * `stateOf` degrades to the event-fold heuristic instead of throwing.
 */
export interface SessionProjectionService {
  snapshot(session: AgentSessionLike): ProjectionSnapshotSurface;
  /** Host `stateOf(session, key)` — one projection value, or undefined. */
  stateOf?(session: AgentSessionLike, key: string): unknown;
}

/**
 * Host `turnBoundary` projection state (`@deepseek-ai/dsh-agent` loop).
 *
 * `openTurnStartSeq !== null` means a turn is running; `lastTurn > 0` means at
 * least one turn has completed. Both cases make a session "already started",
 * which is exactly what locks its agent preset.
 */
export interface TurnBoundaryState {
  readonly openTurnStartSeq?: number | null;
  readonly lastTurn?: number;
}

/**
 * Minimal shape the bridge needs on `agent.session` to call the
 * snapshot face. Defined locally so we don't pull `dsh-session` types
 * into the bridge's static surface; the host concrete `Session` fits
 * via duck typing.
 */
export interface AgentSessionLike {
  readonly seq: number;
}

// ─── Background jobs registry (ctx.jobs) ──────────────────────────────────

/**
 * Terminal + live states the host's `JobStatus` can hold. Declared as a plain
 * string union here (not imported) so the bridge keeps its zero-runtime
 * coupling to `@deepseek-ai/*`; the host's branded type is assignable to it.
 */
export type JobStatusView = "running" | "stopping" | "completed" | "killed" | "failed";

/**
 * One background job as `/status` reads it.
 *
 * The host `JobView` also carries `outputLimitBytes` and an `output` cursor
 * record; neither is consumed here, and omitting them keeps this surface
 * small. Everything else matches field-for-field.
 */
export interface JobViewLike {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  /** Session that owns the job; absent for a job started outside any session. */
  readonly owner?: string;
  readonly status: JobStatusView;
  readonly progress?: string;
  readonly detail?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

/**
 * Structural surface of `ctx.jobs` (the abstract background job registry).
 *
 * Only `list` is declared: `/status` reports what is running, it never starts,
 * reads, waits on or kills anything. `list(caller)` is owner-fenced by the
 * host — a caller sees its own jobs plus unowned ones — which is why the
 * bridge passes the bound session id rather than filtering a global list.
 */
export interface JobsService {
  list(caller?: string): readonly JobViewLike[];
}

/**
 * One provider/model/effort selection as exposed by the host's
 * `modelSelection` projection. Unlike {@link ModelSelection} in `ops.ts`
 * every field is optional because the projection is read through an
 * unknown-valued `Record<string, unknown>` and may be absent.
 */
export interface ModelSelectionView {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

/**
 * Fold the host `modelSelection` projection value into a selection.
 *
 * DSH 0.2.1's session controller publishes
 * `{ lastUsed, next }` (both nullable): `next` is the durable
 * `model/selection` the following request should use, `lastUsed` is the
 * selection consumed by the latest recorded request. This is the same
 * pair the GUI model picker and `session.selectModel` operate on, so
 * reading it keeps WeChat on the host-owned selection instead of
 * inventing a second one. Returns `undefined` for absent/malformed
 * values; callers fall back to the session request header, the agent
 * options, or the deployment default.
 */
export function modelSelectionFromProjection(value: unknown): ModelSelectionView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const projected = value as { next?: unknown; lastUsed?: unknown };
  const pick = (candidate: unknown): ModelSelectionView | undefined => {
    if (!candidate || typeof candidate !== "object") return undefined;
    const entry = candidate as {
      provider?: unknown;
      model?: unknown;
      reasoningEffort?: unknown;
    };
    if (typeof entry.provider !== "string" || typeof entry.model !== "string") return undefined;
    return {
      provider: entry.provider,
      model: entry.model,
      ...(typeof entry.reasoningEffort === "string"
        ? { reasoningEffort: entry.reasoningEffort }
        : {}),
    };
  };
  return pick(projected.next) ?? pick(projected.lastUsed);
}
