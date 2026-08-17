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

/** Minimal live-agent surface used by the bridge. */
export interface Agent {
  readonly id: string;
  readonly status: "idle" | "running";
  readonly options: { provider?: string; model?: string };
  /** Session header access: the latest logged request config (dsh-session). */
  session?: {
    /** Durable creation metadata: the recorded agent preset, if any. */
    header?: { id?: string; agentPreset?: string };
    /** The session's durable event log (permission fold / blank check). */
    events?: readonly { type: string; data?: unknown }[];
    requestHeader?: () =>
      | {
          config?: { provider?: string; model?: string; reasoningEffort?: string };
        }
      | undefined;
  };
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
  readonly setup?: (agentCtx: unknown) => void;
}

/** ResumeAgentOptions (dsh-agent). */
export interface ResumeAgentOptions {
  readonly resumeSessionId: string;
  readonly agentOptions?: {
    provider?: string;
    model?: string;
  };
  readonly setup?: (agentCtx: unknown) => void;
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
