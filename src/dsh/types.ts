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

/** One durable session-log record the bridge folds (permission / history / blank). */
export interface SessionEventRecord {
  type: string;
  time?: number;
  data?: unknown;
}

/**
 * Live session surface used by the bridge.
 *
 * DSH 0.1.5 publishes `snapshotEvents()` as the public log read. Older
 * hosts still expose `events`; both are accepted.
 */
export interface AgentSession {
  /** Durable creation metadata: the recorded agent preset, if any. */
  header?: { id?: string; agentPreset?: string };
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
  followup(message: UserMessage): void;
  steer(message: UserMessage): void;
  cancel(cause: string, options?: { keepInbox?: boolean }): void;
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
 * Structural surface of `ctx.sessionProjections`. Mirrors only
 * `snapshot`, which is what `/status` needs; `checkpoint` / `restore` /
 * `onChanged` are not consumed.
 */
export interface SessionProjectionService {
  snapshot(session: AgentSessionLike): ProjectionSnapshotSurface;
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
