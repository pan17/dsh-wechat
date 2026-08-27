/**
 * The core bridge: WeChat iLink ⇄ DSH agents.
 *
 * Ported design from wechat-opencode (MIT) — https://github.com/pan17/wechat-opencode
 * The OpenCode Server half is replaced by direct in-process DSH service
 * calls: agents are created/resumed through the `agents` registry, WeChat
 * messages enter via `agent.followup`, assistant output leaves via the
 * `session/event` feed, and approval/question cards are MIRRORED to WeChat
 * from the native `apiProxy` mux frame stream — the decision point and
 * trigger policy stay exactly as in the GUI (`approval.request` from
 * sandbox escalation, `question/requested` from the native ask tool), and
 * WeChat answers are injected back through `apiProxy.respond`. Whoever
 * answers first (GUI or WeChat) wins; there is no custom approval list.
 */

import fs from "node:fs";
import path from "node:path";
import { login, loadToken, type TokenData } from "../weixin/auth.js";
import { startMonitor, clearSyncBuf } from "../weixin/monitor.js";
import { sendTextMessage, sendMediaMessage, splitText } from "../weixin/send.js";
import {
  sendTyping as apiSendTyping,
  getConfig as apiGetConfig,
  isMessageLimitError,
  isSessionTimeoutError,
} from "../weixin/api.js";
import { MessageType, TypingStatus, UploadMediaType } from "../weixin/types.js";
import type { WeixinMessage } from "../weixin/types.js";
import { extractText, weixinMessageToPrompt } from "../adapter/inbound.js";
import { formatForWeChat } from "../adapter/outbound.js";
import { formatQuestionForWeChat, parseQuestionReply, buildAnswer } from "../adapter/question-format.js";
import { formatApprovalCard, parseApprovalReply } from "../adapter/approval-format.js";
import { AgentStore, type BridgeContext } from "../dsh/sessions.js";
import { DshOps } from "../dsh/ops.js";
import type { ModelSelection } from "../dsh/ops.js";
import type { Agent, AskUserQuestionAnswer, AskUserQuestionItem } from "../dsh/types.js";
import {
  MAX_OUTBOUND_QUEUE,
  StateStore,
  type OutboundMessage,
  type UserState,
} from "../state.js";
import type { WeChatDSHConfig } from "../config.js";
import {
  detectUnknownSlashCommand,
  formatHelp,
  isBypassSlashCommand,
  isHistoryCommandAttempt,
  parseCommandName,
  parseHelpCommand,
  parseHistoryCommand,
  renderProjectionSection,
  parseEnterCommand,
  parseModelCommand,
  parseNextCommand,
  parseNotifyCommand,
  parsePermCommand,
  parsePresetCommand,
  parseReasoningCommand,
  parseRejectPermissionCommand,
  parseRejectQuestionCommand,
  parseSessionCommand,
  parseSilentCommand,
  parseStatusCommand,
  parseStopCommand,
  parseWorkspaceCommand,
  HISTORY_MAX,
  type EnterCommand,
  type HistoryCommand,
  type ModelCommand,
  type NotifyCommand,
  type PermCommand,
  type PresetCommand,
  type ReasoningCommand,
  type SessionCommand,
  type WorkspaceCommand,
} from "./slash.js";

/** WeChat gateway continuous-message limit per user interaction window. */
const MSG_LIMIT_MAX = 10;
const MSG_LIMIT_WARN = 7;
/** How long a session's message-source marker stays valid without a touch. */
const SURFACE_TTL_MS = 7 * 24 * 60 * 60_000;
/** typing_ticket cache TTL — re-fetch via getconfig after expiry. */
const TYPING_TICKET_TTL_MS = 5 * 60_000;
/**
 * Periodically re-send TYPING (status=1) while the agent is running, so the
 * WeChat client's own typing-indicator timeout doesn't hide the indicator
 * during long turns. WeChat's indicator typically auto-hides within ~10–30s
 * without a refresh; 10s keeps it consistently visible throughout the turn.
 */
const TYPING_KEEPALIVE_MS = 10_000;
/**
 * TTL fallback for the typing indicator. The safety timer is refreshed on
 * every keepalive tick, so under normal operation it never fires. It only
 * kicks in when the keepalive loop itself stops (e.g. the interval callback
 * fails repeatedly or some other fault blocks the timer queue) — at which
 * point we force-clear the typing indicator to avoid a stuck "正在输入".
 * Matches openclaw's 2-minute safety net.
 */
const TYPING_SAFETY_TIMEOUT_MS = 2 * 60_000;
/** A model selection override for one agent (`/model switch` / `/reasoning`). */
interface ModelOverride {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface LoginState {
  phase: "idle" | "waiting-qr" | "scaned" | "logged-in" | "failed";
  qrUrl?: string;
  error?: string;
  botId?: string;
}

/**
 * One pending question card mirrored from a `question/requested` frame.
 * The answer is injected back through `apiProxy.respond()` into the native
 * pending table (the GUI question box is the same frame's other viewer).
 */
interface PendingQuestion {
  rpcId: string;
  sessionId: string;
  userId: string;
  items: AskUserQuestionItem[];
  askedAt: number;
  timer: NodeJS.Timeout;
}

/**
 * One pending approval card mirrored from an `approval/requested` frame.
 * The decision is injected back through `apiProxy.respond()` — identical
 * information and choices to the GUI card, and whoever answers first
 * (GUI click or WeChat reply) wins; the native settle guard drops the
 * other side.
 */
interface PendingApproval {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  userId: string;
  toolName: string;
  reason?: string;
  askedAt: number;
  timer: NodeJS.Timeout;
}

/** Structural surface of the apiProxy service (host side). */
export interface ApiProxySurface {
  respond(message: {
    type: "client-response";
    rpcId: string;
    result: { ok: true; value: unknown } | { ok: false; error: { code: string } };
  }): Promise<{ accepted: boolean; reason?: string }>;
  events?: unknown;
}

/**
 * Structural surface of the DSH `ctx.commands` plugin-owned human command
 * registry (host side). Mirrors only the minimum the bridge consumes:
 *
 * - `find(agent, name)` — name-presence check; the bridge uses this to
 *   decide whether to dispatch natively or fall through to the local
 *   whitelist. Returns `undefined` when the name is not registered for
 *   this agent.
 * - `execute(agent, line, signal)` — full parse + dispatch; returns the
 *   settled `CommandExecution` (`{ commandId, result: CommandResult }`)
 *   or `undefined` for invalid syntax / unknown names. The bridge reads
 *   `result.kind` / `result.text` and renders to WeChat. Per the host
 *   type contract, `CommandResult` is `{ kind: 'success', text? }` or
 *   `{ kind: 'error', text }` — the success text is optional (some
 *   commands reply through `sourceEventSeq` instead), the error text
 *   is required.
 * - `list(agent)` — name-sorted descriptors for discovery; used by
 *   `/help` to surface whatever the host has registered so users can
 *   discover commands that have no entry in this plugin's local docs.
 *
 * No `@deepseek-ai/*` runtime dep — the registry lives in the host
 * process; the bridge reaches it via `ctx.inject(['commands'], ...)`
 * through the cordis injection pattern already used for `tools` /
 * `apiProxy` / `systemPrompt`.
 */
export interface NativeCommandsSurface {
  find(
    agent: Agent,
    name: string,
  ): { name: string; description?: string; input?: { hint?: string } } | undefined;
  /**
   * Mirrors `@deepseek-ai/dsh-commands.CommandRuntime.execute`. The host
   * signature is `(agent, line, images, signal)` — `images` is the composer
   * attachment batch (base64-encoded), and `signal` is the UI request's
   * cancellation signal. WeChat has no composer attachment surface, so the
   * bridge always passes `[]`; the previous 3-arg call placed the signal
   * in `images`'s slot, leaving `signal` undefined inside the host handler
   * and triggering `Cannot read properties of undefined (reading
   * 'aborted')` on every native command.
   */
  execute(
    agent: Agent,
    line: string,
    images: readonly unknown[],
    signal: AbortSignal,
  ): Promise<
    | {
        commandId: string;
        result:
          | { kind: "success"; text?: string; sourceEventSeq?: number }
          | { kind: "error"; text: string };
      }
    | undefined
  >;
  list(agent: Agent): Array<{
    name: string;
    description?: string;
    input?: { hint?: string };
  }>;
}

type CachedMessage = OutboundMessage;

export class WeChatDSHBridge {
  private readonly ctx: BridgeContext;
  private config: WeChatDSHConfig;
  private readonly state: StateStore;
  private readonly agents: AgentStore;
  private readonly ops: DshOps;

  private token: TokenData | null = null;
  /**
   * Gateway rejected the current bot session (`-14` / session timeout).
   * Distinct from `token === null` (never logged in / mid re-login).
   * While invalid and not given up, outbound is parked and flushed on recover.
   * Cleared when getUpdates succeeds again or a fresh QR login lands.
   */
  private tokenInvalid = false;
  /**
   * `-14` recovery exhausted (re-scan hint). Further outbound is dropped,
   * and any parked items are discarded.
   */
  private tokenGiveUp = false;
  /**
   * Single WeChat peer. First inbound user wins; later distinct
   * `from_user_id`s are ignored. Single-user deployments only.
   */
  private peerUserId: string | null = null;
  /**
   * Latest inbound iLink `context_token` for the peer. Wired into the
   * send payload when present; never used as a send gate.
   */
  private wireContextToken: string | null = null;
  /** Per-run monitor cancellation; recreated on every reconnect. */
  private monitorAbort: AbortController | null = null;
  private monitorRunning = false;
  private loginState: LoginState = { phase: "idle" };
  /** Pending question cards per user (rpcId-keyed, first = active). */
  private readonly pendingQuestions = new Map<string, PendingQuestion[]>();
  /** Pending approval cards per user (rpcId-keyed). */
  private readonly pendingApprovals = new Map<string, PendingApproval[]>();
  private readonly silentBuffers = new Map<string, string[]>();
  /** One global queue and budget: dsh-wechat intentionally serves one peer. */
  private outboundCache: CachedMessage[] = [];
  private wechatMsgCount = 0;
  private cacheNoticeSent = false;
  /** Serializes all outbound budget/queue mutations across assistant and tool sends. */
  private outboundSerial: Promise<void> = Promise.resolve();
  /** Per-agent model overrides set by `/model switch` / `/reasoning` (applied via agent/request). */
  private readonly modelOverrides = new Map<string, ModelOverride>();
  /**
   * Sessions whose pending cards were only *notified* (not shown) to a user
   * because they belonged to a non-current session. Keyed by user id; the
   * set holds session ids with pending cards the user has been told about.
   * Clearing happens when the user switches into the session and the cards
   * are flushed (or reported gone).
   */
  private readonly notifiedCardSessions = new Map<string, Set<string>>();
  /** Dedup for cross-session turn/end notifications (userId -> sessionIds already notified this turn). */
  private readonly notifiedCrossSessionTurns = new Map<string, Set<string>>();
  /** Last assistant text per session (for cross-session completion preview). */
  private readonly lastAssistantTextBySession = new Map<string, string>();
  /**
   * Last user-prompt time per session (from `user/message` events with
   * source.kind === "user" — the same activity the GUI sidebar uses). Used
   * for `/s list` ordering and the time column; sessions without a recorded
   * activity (cold after restart) fall back to their creation time.
   */
  private readonly lastActivityBySession = new Map<string, number>();
  /**
   * Per-session message-source tracking for the dynamic WeChat surface
   * prompt: the most recent user-message origin per session ("wechat" when
   * the last user message was injected from WeChat, "gui" when it came from
   * the GUI chat box). The global `dsh-wechat-surface` prompt section
   * consults this via `surfaceSourceFor()` at assembly time, so the WeChat
   * prompt follows the message source — present exactly while WeChat
   * messages drive the session, absent while GUI messages do. Entries are
   * lazily dropped after SURFACE_TTL_MS without a touch.
   */
  private readonly sourceBySession = new Map<string, { source: "wechat" | "gui"; at: number }>();
  /**
   * Ids of user messages this bridge injected from WeChat (pending their
   * `user/message` echo), so `handleSessionEvent` can tell WeChat-injected
   * messages apart from GUI-typed ones. One-shot consumption with a TTL.
   */
  private readonly wechatMessageIds = new Map<string, number>();
  /** apiProxy for respond() injection; set by attachMux. */
  private apiProxy: ApiProxySurface | null = null;
  /** Current mux stream abort; replaced on each reopen. */
  private muxAbort: AbortController | null = null;
  /** True after plugin dispose; the mux loop must not reopen. */
  private muxStopped = false;
  /** True while a mux loop is running (attachMux is idempotent). */
  private muxLoopStarted = false;
  /**
   * DSH native command registry (ctx.commands) when present in the host.
   * Set late by `attachCommands` once the cordis commands child has
   * resolved (host's own injection pattern). When `null` the bridge
   * silently skips the native command layer and the local whitelist
   * keeps full ownership — every `/xxx` either hits a hard-coded branch
   * or is forwarded as text to the agent.
   */
  private commandsCtx: NativeCommandsSurface | null = null;
  /**
   * Per-user typing_ticket cache: the iLink `sendtyping` ticket is short-lived
   * and tied to the user's current context. We re-fetch via getconfig only on
   * miss / TTL expiry; otherwise the same ticket is reused across multiple
   * status changes of the same turn.
   */
  private readonly typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  /**
   * Per-user active typing indicator. Tracks which user/session is currently
   * shown as "正在输入", so we can (a) suppress duplicate TYPING sends on
   * re-entry, (b) periodically refresh the indicator (TYPING is fire-and-
   * forget and the WeChat client auto-hides after a few seconds), and
   * (c) cancel cleanly on turn end / agent error / plugin stop. The
   * `safetyTimer` is the TTL fallback — it is refreshed by every keepalive
   * tick and only fires if the keepalive loop itself stops running.
   */
  private readonly typingActive = new Map<string, {
    sessionId: string;
    startedAt: number;
    keepAliveTimer: NodeJS.Timeout;
    safetyTimer: NodeJS.Timeout;
  }>();

  constructor(ctx: BridgeContext, config: WeChatDSHConfig, commandsCtx?: NativeCommandsSurface | null) {
    this.ctx = ctx;
    this.config = config;
    this.state = new StateStore(config.storageDir);
    this.restoreOutboundState();
    this.agents = new AgentStore(ctx);
    this.ops = new DshOps(ctx);
    if (commandsCtx) this.commandsCtx = commandsCtx;
  }

  /** Hydrate the one peer's persisted budget and queue without auto-flushing. */
  private restoreOutboundState(): void {
    const saved = this.state.outbound();
    if (!saved) return;
    const firstPeer = this.state.all()[0]?.userId;
    if (firstPeer && firstPeer !== saved.peerUserId) {
      this.log(`discard outbound snapshot for old peer ${saved.peerUserId}; current peer is ${firstPeer}`);
      try {
        this.state.clearOutbound();
      } catch (err) {
        this.log(`failed to clear mismatched outbound snapshot: ${String(err)}`);
      }
      return;
    }
    this.wechatMsgCount = saved.messageCount;
    this.outboundCache = saved.queue.map((item) => ({ ...item }));
  }

  /** Persist the one peer's budget/queue; empty state needs no snapshot. */
  private persistOutboundState(peerUserId = this.peerUserId ?? this.state.all()[0]?.userId): void {
    try {
      if (!peerUserId || (this.wechatMsgCount === 0 && this.outboundCache.length === 0)) {
        this.state.clearOutbound();
        return;
      }
      this.state.setOutbound({
        version: 1,
        peerUserId,
        messageCount: this.wechatMsgCount,
        queue: this.outboundCache.map((item) => ({ ...item })),
      });
    } catch (err) {
      this.log(`failed to persist outbound state: ${String(err)}`);
    }
  }

  /** Serialize remote sends with budget and durable queue mutations. */
  private serializeOutbound<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.outboundSerial.then(operation, operation);
    this.outboundSerial = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Late-bind the native command registry (`ctx.commands`).
   *
   * Called from `src/index.ts` after the host's commands child has
   * resolved via `ctx.inject(['commands'], ...)`. Idempotent: a second
   * call with the same surface is a no-op, a `null` is recorded as the
   * "unavailable" state.
   */
  attachCommands(commandsCtx: NativeCommandsSurface | null): void {
    this.commandsCtx = commandsCtx;
  }

  /**
   * True when the line shape is a candidate for native command bypass
   * of a pending approval/question card. Used by `bypassCard` so a card
   * does not silently swallow a `/plan off` while waiting for the user.
   *
   * Two-gate:
   *   1. The host's `ctx.commands` registry is composed — without it
   *      the native dispatch layer is dormant and we must not bypass.
   *   2. The shape parses as a leading-slash lowercase command name
   *      (`parseCommandName`).
   *
   * `find(agent, name)` is NOT called here: at the bypass-card decision
   * point the bound agent may not be ensured yet (cost reasons) and
   * "shape-not-registered" is correctly re-detected inside
   * `tryNativeCommand` — a name that parses but is unregistered simply
   * falls through. The cost is that dsh-wechat-owned commands whose
   * shape parses as a slash name (today: `/rp`, `/rq`, `/stop`) would
   * bypass the card if matched here; those names are explicitly excluded
   * below so the card handler keeps full ownership of their semantics.
   */
  private isBypassableNativeCommand(text: string): boolean {
    if (!text || !this.commandsCtx) return false;
    const name = parseCommandName(text);
    if (!name) return false;
    if (name === "rp" || name === "rq" || name === "stop") return false;
    return true;
  }

  /**
   * Probe the host's `ctx.commands` registry for the leading-slash name
   * in `text`; if registered, run the native handler and render its
   * settled result as a single WeChat reply. Returns `true` iff the
   * reply was sent (the caller should stop processing); returns `false`
   * for every "not ours" case so the local whitelist / forwarding
   * pipeline continues unchanged.
   *
   * Failure isolation: a thrown native handler is caught and rendered as
   * a friendly "command execution exception" reply; the message is never
   * silently forwarded to the agent (a malformed command must not look
   * like a real user prompt).
   *
   * The agent is ensured lazily on first hit so cold sessions without a
   * cached DSH session still resolve cleanly. We do NOT call
   * `agents.ensure` for unmatched names — the call would be wasted work
   * on the (very common) "user typed `/foo bar`" path.
   */
  private async tryNativeCommand(
    user: UserState,
    userId: string,
    text: string,
  ): Promise<boolean> {
    if (!this.commandsCtx || !text) return false;
    const name = parseCommandName(text);
    if (!name) return false;
    if (name === "rp" || name === "rq" || name === "stop") return false;
    const agent = await this.agents.ensure(user);
    if (!agent) {
      // Cannot resolve a session to scope `find` against — preserve the
      // existing fall-through behavior (next layer is `forwardToAgent`,
      // which itself fails with the same "无法创建/恢复 DSH 会话" hint).
      return false;
    }
    let def: ReturnType<NativeCommandsSurface["find"]> | undefined;
    let result: Awaited<ReturnType<NativeCommandsSurface["execute"]>>;
    try {
      def = this.commandsCtx.find(agent, name);
      if (!def) return false;
      const abort = new AbortController();
      // The host's execute signature is `(agent, line, images, signal)`.
      // WeChat has no composer attachment surface, so the images batch is
      // always empty; passing the signal in the third slot (the previous
      // behavior) made the host's `signal` argument undefined and threw
      // `Cannot read properties of undefined (reading 'aborted')` on every
      // native command. See NativeCommandsSurface for the contract.
      result = await this.commandsCtx.execute(agent, text, [], abort.signal);
    } catch (err) {
      console.warn(`[dsh-wechat] native command ${name} threw: ${String(err)}`);
      const detail = err instanceof Error ? err.message : String(err);
      await this.sendReply(userId, `⚠️ 命令执行异常：${detail}`);
      return true;
    }
    if (result === undefined) return false;
    // CommandExecution carries `result: CommandResult` (see
    // packages/interaction/commands/src/types.ts): `success` may omit
    // text (commands that reply via `sourceEventSeq` instead), `error`
    // always carries text. Render the success text when present, fall
    // back to a generic acknowledgement when it isn't, and surface the
    // handler's own error message verbatim when it is.
    if (result.result.kind === "success") {
      const text2 = result.result.text ?? `✅ ${name}`;
      await this.sendReply(userId, text2);
    } else {
      await this.sendReply(userId, `⚠️ 命令出错：${result.result.text}`);
    }
    return true;
  }

  /**
   * Resolve the host's native command descriptors for `/help` discovery.
   *
   * Returns the name-sorted `ctx.commands.list(agent)` snapshot when
   * the registry is composed AND an agent is bound; returns an empty
   * array otherwise. The host registry may legitimately list commands
   * that are not yet defined for the bound agent — `formatHelp` then
   * falls back to those entries; the bridge never re-filters by the
   * local whitelist (de-duplication is `formatHelp`'s job). A failed
   * `list` is logged once and treated as "no native commands" so
   * `/help` still works for users with a degraded registry.
   */
  private async listNativeCommandsForHelp(
    user: UserState,
  ): Promise<ReadonlyArray<{ name: string; description?: string; input?: { hint?: string } }>> {
    if (!this.commandsCtx) return [];
    const agent = await this.agents.ensure(user);
    if (!agent) return [];
    try {
      return this.commandsCtx.list(agent);
    } catch (err) {
      console.warn(`[dsh-wechat] ctx.commands.list failed: ${String(err)}`);
      return [];
    }
  }

  // ─── Lifecycle ───

  getLoginState(): LoginState {
    return this.loginState;
  }

  /** Current effective config (for the settings page). */
  getConfig(): WeChatDSHConfig {
    return this.config;
  }

  /** Full status snapshot for the settings page / QR page. */
  getStatus(): Record<string, unknown> {
    const editable: Record<string, unknown> = {};
    for (const key of ["baseUrl", "cdnBaseUrl", "botType", "cwd", "textChunkLimit", "cardTimeoutMs", "crossSessionNotify"] as const) {
      editable[key] = this.config[key];
    }
    return {
      ...this.loginState,
      monitorRunning: this.monitorRunning,
      userCount: this.state.all().length,
      users: this.state.all().map((u) => ({
        userId: u.userId,
        sessionId: u.sessionId,
        cwd: u.cwd,
        silent: u.silent,
        crossSessionNotify: u.crossSessionNotify ?? "inherit",
        watchedSessions: u.watchedSessions ?? [],
      })),
      config: editable,
    };
  }

  /**
   * Message-source marker for one session, consulted by the global
   * `dsh-wechat-surface` prompt section at assembly time. "wechat" means
   * the most recent user message came from WeChat (the WeChat prompt is
   * shown); "gui" (or undefined) means it did not (the prompt is hidden).
   * Stale markers are dropped lazily.
   */
  surfaceSourceFor(sessionId: string): "wechat" | "gui" | undefined {
    const entry = this.sourceBySession.get(sessionId);
    if (!entry) return undefined;
    if (Date.now() - entry.at > SURFACE_TTL_MS) {
      this.sourceBySession.delete(sessionId);
      return undefined;
    }
    return entry.source;
  }

  /** Remember one WeChat-injected message id for echo matching. */
  private markWechatMessage(messageId: string): void {
    this.wechatMessageIds.set(messageId, Date.now());
  }

  /** Record that the last user message in `sessionId` came from WeChat. */
  private markSessionSource(sessionId: string, source: "wechat" | "gui"): void {
    this.sourceBySession.set(sessionId, { source, at: Date.now() });
  }

  // ─── Typing indicator (iLink sendtyping) ───
  //
  // When the agent starts processing a WeChat-bound turn, push a native
  // "正在输入" status to the WeChat client; refresh it periodically so the
  // client does not auto-hide it; clear it on turn end, agent error, or
  // plugin stop. There is NO safety timeout — the indicator mirrors
  // agent.status exactly and stays on as long as the turn is running,
  // even through assistant text, tool calls, and approval/question card
  // waits.
  //
  // WeChat iLink requires a fresh typing_ticket per sendtyping call; we
  // fetch it lazily via /ilink/bot/getconfig and cache it for 5 minutes.
  // All iLink calls are best-effort: a failed sendtyping never breaks the
  // message-reply path.

  /**
   * Resolve a usable typing_ticket for the given user, caching the result
   * for `TYPING_TICKET_TTL_MS`. Returns undefined when the bot is not
   * logged in or the iLink call fails (caller treats this as "skip").
   */
  /** Bot can talk to WeChat: logged in and the gateway has not rejected the session. */
  private botReady(): boolean {
    return this.token !== null && !this.tokenInvalid;
  }

  private markTokenInvalid(): void {
    if (this.tokenInvalid) return;
    this.tokenInvalid = true;
    this.log("-14 session timeout: park outbound until recover (messages and cards)");
  }

  private markTokenRecovered(): void {
    if (this.tokenGiveUp) {
      this.log("-14 recovered after give-up; parked outbound already discarded");
      this.tokenInvalid = false;
      this.tokenGiveUp = false;
      return;
    }
    if (!this.tokenInvalid) return;
    this.tokenInvalid = false;
    this.log("-14 recovered; flushing parked outbound");
    void this.flushParkedAfterRecover();
  }

  private markTokenGiveUp(): void {
    if (this.tokenGiveUp) return;
    this.tokenGiveUp = true;
    this.log("-14 recovery failed; re-scan required — discarding parked outbound");
    this.discardQueuedOutbound("session-timeout-give-up");
  }

  private dropOutboundReason(): "missing" | "invalid" | "give-up" | null {
    if (this.token === null) return "missing";
    if (this.tokenGiveUp) return "give-up";
    if (this.tokenInvalid) return "invalid";
    return null;
  }

  private logDropOutbound(preview: string): void {
    const reason = this.dropOutboundReason();
    if (reason === "give-up") {
      this.log(`drop outbound (bot token invalid, re-scan required): ${preview}`);
    } else if (reason === "invalid") {
      this.log(`park outbound (-14 recovering): ${preview}`);
    } else {
      this.log(`drop outbound (bot token missing): ${preview}`);
    }
  }

  private async getTypingTicket(userId: string, contextToken: string | undefined): Promise<string | undefined> {
    const cached = this.typingTickets.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;
    const token = this.token;
    if (!token || this.tokenInvalid) return undefined;
    try {
      const resp = await apiGetConfig({
        baseUrl: token.baseUrl,
        token: token.token,
        ilinkUserId: userId,
        contextToken,
      });
      if (!resp.typing_ticket) return undefined;
      this.typingTickets.set(userId, {
        ticket: resp.typing_ticket,
        expiresAt: Date.now() + TYPING_TICKET_TTL_MS,
      });
      return resp.typing_ticket;
    } catch (err) {
      this.log(`getconfig for typing_ticket failed: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Best-effort iLink sendtyping call. Swallows all errors so a transient
   * iLink failure never breaks the surrounding message flow.
   */
  private async sendTypingStatus(userId: string, status: 1 | 2): Promise<void> {
    const token = this.token;
    if (!token || this.tokenInvalid) return;
    const ticket = await this.getTypingTicket(userId, this.wireContextToken ?? undefined);
    if (!ticket) return;
    const still = this.token;
    if (!still || this.tokenInvalid) return;
    try {
      await apiSendTyping({
        baseUrl: still.baseUrl,
        token: still.token,
        body: { ilink_user_id: userId, typing_ticket: ticket, status },
      });
    } catch (err) {
      this.log(`sendtyping(${status}) failed: ${String(err)}`);
    }
  }

  /**
   * Show the typing indicator for `userId` on the bound session. Idempotent:
   * a second call while the indicator is already active is a no-op. Starts
   * a periodic refresh (`TYPING_KEEPALIVE_MS`) so the WeChat client does
   * not auto-hide the indicator during long turns, and a safety timer
   * (`TYPING_SAFETY_TIMEOUT_MS`) refreshed on every keepalive tick so a
   * stuck keepalive loop doesn't leave a phantom "正在输入" forever. The
   * indicator is removed by `endTyping` on turn end, agent error, plugin
   * stop, or (as a safety net) when the keepalive loop itself stops.
   */
  private beginTyping(userId: string, sessionId: string): void {
    if (this.typingActive.has(userId)) return;
    // The safety timer is captured by the closure so each keepalive tick can
    // clearTimeout(stale) + setTimeout(new) to refresh it. endTyping clears
    // the latest one via `active.safetyTimer`; if a tick has already swapped
    // in a newer handle, `clearTimeout` on the stale one is a no-op.
    let safetyTimer: NodeJS.Timeout = setTimeout(() => {
      this.endTyping(userId, "safety-timeout");
    }, TYPING_SAFETY_TIMEOUT_MS);
    const refreshSafetyTimer = (): void => {
      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(() => {
        this.endTyping(userId, "safety-timeout");
      }, TYPING_SAFETY_TIMEOUT_MS);
    };
    const keepAliveTimer = setInterval(() => {
      void this.sendTypingStatus(userId, TypingStatus.TYPING);
      refreshSafetyTimer();
    }, TYPING_KEEPALIVE_MS);
    this.typingActive.set(userId, {
      sessionId,
      startedAt: Date.now(),
      keepAliveTimer,
      safetyTimer,
    });
    void this.sendTypingStatus(userId, TypingStatus.TYPING);
  }

  /**
   * Clear the typing indicator for `userId`. Idempotent: no-op when nothing
   * is active. `reason` names the call site (safety-timeout / plugin-stop /
   * turn-end, …) and is not logged.
   */
  private endTyping(userId: string, _reason: string): void {
    const active = this.typingActive.get(userId);
    if (!active) return;
    clearInterval(active.keepAliveTimer);
    clearTimeout(active.safetyTimer);
    this.typingActive.delete(userId);
    void this.sendTypingStatus(userId, TypingStatus.CANCEL);
  }

  /** Start the bridge: resume with a stored token or begin QR login. */
  async start(): Promise<void> {
    this.token = loadToken(this.config.storageDir);
    this.tokenInvalid = false;
    this.tokenGiveUp = false;
    if (this.token) {
      this.lockPeerFromState();
      this.loginState = { phase: "logged-in", botId: this.token.accountId };
      await this.startMonitor();
    } else {
      // No bot token: the next QR login may be a different WeChat account.
      this.resetPeerBinding("start-without-token");
      void this.startLoginFlow();
    }
  }

  /** First persisted user is the single peer (legacy multi-user files keep only the first). */
  private lockPeerFromState(): void {
    const first = this.state.all()[0];
    if (first) this.peerUserId = first.userId;
  }

  /**
   * Plugin dispose: stop the iLink monitor AND the DSH mux feed.
   * WeChat reconnect/logout must NOT use this — they only bounce the
   * gateway long-poll (`stopIlink`). Mux is a DSH-side subscription and
   * stays alive across QR re-login.
   */
  async stop(): Promise<void> {
    this.stopIlink("plugin-stop");
    this.stopMux();
  }

  /** Stop the WeChat long-poll and typing indicators; leave mux running. */
  private stopIlink(typingReason: string): void {
    this.monitorAbort?.abort();
    this.monitorAbort = null;
    for (const userId of [...this.typingActive.keys()]) {
      this.endTyping(userId, typingReason);
    }
  }

  /**
   * Restart the iLink long-poll with the current token (or begin QR login
   * when no token exists). Used after gateway config changes, not as a
   * user-facing "reconnect" action — that duplicated 重新扫码.
   */
  async reconnect(): Promise<{ ok: boolean; message: string }> {
    this.stopIlink("reconnect");
    this.token = loadToken(this.config.storageDir);
    this.tokenInvalid = false;
    this.tokenGiveUp = false;
    if (this.token) {
      this.lockPeerFromState();
      this.loginState = { phase: "logged-in", botId: this.token.accountId };
      await this.startMonitor();
      return { ok: true, message: `已重连 (Bot: ${this.token.accountId})` };
    }
    this.resetPeerBinding("reconnect-without-token");
    void this.startLoginFlow();
    return { ok: true, message: "未找到登录令牌，已开始扫码登录" };
  }

  /**
   * Force re-login: drop the stored token and start a fresh QR flow.
   */
  async relogin(): Promise<{ ok: boolean; message: string }> {
    this.stopIlink("relogin");
    this.deleteToken();
    this.token = null;
    this.tokenInvalid = false;
    this.tokenGiveUp = false;
    this.loginState = { phase: "idle" };
    this.discardQueuedOutbound("relogin");
    this.resetPeerBinding("relogin");
    void this.startLoginFlow();
    return { ok: true, message: "已开始重新扫码登录" };
  }

  /** Log out: stop the monitor and remove the stored token. */
  async logout(): Promise<{ ok: boolean; message: string }> {
    this.stopIlink("logout");
    this.deleteToken();
    this.token = null;
    this.tokenInvalid = false;
    this.tokenGiveUp = false;
    this.loginState = { phase: "idle" };
    this.discardQueuedOutbound("logout");
    this.resetPeerBinding("logout");
    return { ok: true, message: "已退出登录" };
  }

  /**
   * A new QR login is a new bot session. Forget the previous WeChat peer
   * (memory + `state.json`) and the old long-poll cursor, otherwise the
   * first inbound from a different account is dropped as
   * `ignore inbound … (single-user peer is <old>)`.
   */
  private resetPeerBinding(reason: string): void {
    const previous = this.peerUserId ?? this.state.all()[0]?.userId;
    this.peerUserId = null;
    this.wireContextToken = null;
    this.typingTickets.clear();
    this.pendingQuestions.clear();
    this.pendingApprovals.clear();
    this.notifiedCardSessions.clear();
    this.notifiedCrossSessionTurns.clear();
    try {
      this.state.clearUsers();
    } catch (err) {
      this.log(`failed to clear persisted users on ${reason}: ${String(err)}`);
    }
    try {
      clearSyncBuf(this.config.storageDir);
    } catch (err) {
      this.log(`failed to clear sync buf on ${reason}: ${String(err)}`);
    }
    if (previous) {
      this.log(`reset single-user peer ${previous} on ${reason}; next inbound WeChat user becomes the peer`);
    }
  }

  /**
   * Drop every not-yet-sent WeChat payload. Logout / re-login must not
   * keep GUI replies from the logged-out window and then flush them on
   * the next inbound ping.
   */
  private discardQueuedOutbound(reason: string): void {
    const parked = this.outboundCache.length;
    this.outboundCache = [];
    this.cacheNoticeSent = false;
    this.wechatMsgCount = 0;
    this.silentBuffers.clear();
    this.persistOutboundState();
    if (parked > 0) {
      this.log(`discarded ${parked} queued outbound item(s) on ${reason}`);
    }
  }

  private deleteToken(): void {
    try {
      const tokenPath = path.join(this.config.storageDir, "auth", "token.json");
      if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    } catch {
      // best effort
    }
  }

  private async startLoginFlow(): Promise<void> {
    try {
      this.loginState = { phase: "waiting-qr" };
      const token = await login({
        baseUrl: this.config.baseUrl,
        botType: this.config.botType,
        storageDir: this.config.storageDir,
        log: (msg) => console.log(`[dsh-wechat] ${msg}`),
        renderQrUrl: (url) => {
          this.loginState = { ...this.loginState, phase: "waiting-qr", qrUrl: url };
          // Always log the URL: the web page at /wechat/qr is the primary
          // viewer, but a terminal user can open the link directly.
          console.log(`[dsh-wechat] QR URL: ${url}`);
        },
      });
      this.token = token;
      this.tokenInvalid = false;
      this.tokenGiveUp = false;
      this.loginState = { phase: "logged-in", botId: token.accountId };
      await this.startMonitor();
    } catch (err) {
      this.loginState = { phase: "failed", error: String(err) };
      console.error(`[dsh-wechat] login failed: ${String(err)}`);
    }
  }

  private async startMonitor(): Promise<void> {
    if (this.monitorRunning || !this.token) return;
    this.monitorRunning = true;
    const abort = new AbortController();
    this.monitorAbort = abort;
    void startMonitor({
      baseUrl: this.token.baseUrl,
      token: this.token.token,
      storageDir: this.config.storageDir,
      abortSignal: abort.signal,
      log: (msg) => console.log(`[dsh-wechat] ${msg}`),
      onMessage: (msg) => {
        this.handleMessage(msg).catch((err) => {
          console.error(`[dsh-wechat] handleMessage error: ${String(err)}`);
        });
      },
      onSessionInvalid: () => this.markTokenInvalid(),
      onSessionRecovered: () => this.markTokenRecovered(),
      onSessionGiveUp: () => this.markTokenGiveUp(),
    })
      .catch((err) => {
        console.error(`[dsh-wechat] monitor stopped: ${String(err)}`);
      })
      .finally(() => {
        this.monitorRunning = false;
        if (this.monitorAbort === abort) this.monitorAbort = null;
      });
  }

  // ─── Config updates (from the settings page) ───

  /**
   * Apply a config patch. Returns the updated editable values. When the
   * gateway connection fields change while logged in, the monitor is
   * restarted automatically.
   */
  async updateConfig(patch: Partial<import("../config-store.js").EditableConfig>): Promise<{ config: Record<string, unknown>; message: string }> {
    const before = { ...this.config };
    const changed = (Object.keys(patch) as Array<keyof typeof patch>).filter((k) => patch[k] !== undefined);
    for (const key of changed) {
      (this.config as unknown as Record<string, unknown>)[key] = patch[key];
    }
    const connectionChanged =
      (patch.baseUrl !== undefined && patch.baseUrl !== before.baseUrl) ||
      (patch.cdnBaseUrl !== undefined && patch.cdnBaseUrl !== before.cdnBaseUrl) ||
      (patch.botType !== undefined && patch.botType !== before.botType);

    // Settings-page cwd is the DEFAULT workspace: apply it to users who never
    // explicitly switched workspaces (cwdExplicit unset). Explicit choices
    // made via /workspace or /session switch are preserved.
    let appliedCwd = 0;
    if (patch.cwd !== undefined && patch.cwd !== before.cwd) {
      for (const user of this.state.all()) {
        if (user.cwdExplicit !== true) {
          this.state.update(user.userId, { cwd: patch.cwd });
          appliedCwd++;
        }
      }
    }

    const editable: Record<string, unknown> = {};
    for (const key of ["baseUrl", "cdnBaseUrl", "botType", "cwd", "textChunkLimit", "cardTimeoutMs", "crossSessionNotify"] as const) {
      editable[key] = this.config[key];
    }

    if (connectionChanged && this.token) {
      void this.reconnect();
      return { config: editable, message: "配置已保存；网关参数已变更，正在重连…" };
    }
    if (appliedCwd > 0) {
      return { config: editable, message: `配置已保存；工作目录已应用到 ${appliedCwd} 个用户（显式切换过的保留原样）` };
    }
    return { config: editable, message: "配置已保存" };
  }

  /**
   * Update per-user settings from the WebUI (silent / crossSessionNotify).
   * Returns the updated user snapshot or null when user not found.
   */
  updateUserConfig(
    userId: string,
    patch: { silent?: boolean; crossSessionNotify?: "inherit" | "on" | "off" },
  ): { ok: boolean; message: string; user?: UserState } {
    const user = this.state.getUser(userId);
    if (!user) return { ok: false, message: `未找到用户 ${userId}` };
    const toUpdate: Partial<UserState> = {};
    if (typeof patch.silent === "boolean") toUpdate.silent = patch.silent;
    if (patch.crossSessionNotify === "on" || patch.crossSessionNotify === "off" || patch.crossSessionNotify === "inherit") {
      toUpdate.crossSessionNotify = patch.crossSessionNotify;
    }
    if (Object.keys(toUpdate).length === 0) return { ok: false, message: "无有效更新字段" };
    this.state.update(userId, toUpdate);
    return { ok: true, message: "已更新", user: this.state.getUser(userId) };
  }

  // ─── User lookup ───

  /** Resolve the bound WeChat user for a DSH agent id. */
  userForAgent(agentId: string): UserState | undefined {
    for (const user of this.state.all()) {
      if (user.sessionId === agentId) return user;
    }
    return undefined;
  }

  // ─── Inbound: WeChat → DSH ───

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== MessageType.USER) return;
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    if (!userId) return;

    if (this.peerUserId && this.peerUserId !== userId) {
      this.log(`ignore inbound from ${userId} (single-user peer is ${this.peerUserId})`);
      return;
    }
    if (!this.peerUserId) this.peerUserId = userId;
    if (typeof msg.context_token === "string" && msg.context_token) {
      this.wireContextToken = msg.context_token;
    }

    // Any incoming message from the one peer opens a fresh gateway window.
    this.wechatMsgCount = 0;
    this.cacheNoticeSent = false;

    const user = this.state.ensureUser(userId, this.config.cwd);
    this.persistOutboundState(userId);

    // Pull text once so both the card handler and the slash command
    // bypass check see the same input.
    const text = extractText(msg.item_list);
    // Slash commands whose meaning is unrelated to the pending card (e.g.
    // `/next` to flush cached outbound, `/silent on`, `/status`,
    // `/workspace …`) bypass the card and execute normally. The
    // card-specific commands (`/rp`, `/rq`) stay in the card handler and
    // keep their existing semantics (reject the card). Empty text returns
    // false here so the empty-text card hint branch still fires.
    //
    // Native commands registered in the host's `ctx.commands` (e.g.
    // `/plan`, `/goal`, `/compact`) also bypass the card — a pending
    // approval/question card must not swallow a management command.
    // `isBypassableNativeCommand` only matches shapes the registry could
    // plausibly own; the dsh-wechat-owned `/rp`/`/rq`/`/stop` semantics
    // are kept off this branch so the card handler retains its meaning
    // even when the native registry happens to be composed.
    const bypassCard =
      text !== "" &&
      (isBypassSlashCommand(text) || this.isBypassableNativeCommand(text));

    // Pending approval cards for the CURRENT session: the next text is
    // (almost always) a decision. Cards of other sessions do not capture
    // messages — the user must switch into that session first (a notice
    // was sent when the card arrived). A recognized non-card slash
    // command bypasses this branch.
    const approvals = (this.pendingApprovals.get(userId) ?? []).filter(
      (c) => c.sessionId === user.sessionId,
    );
    if (!bypassCard && approvals.length > 0) {
      if (text === null || text === "") {
        await this.sendReply(userId, "⚠️ 当前有权限卡待处理，请用文本回复（1 允许一次 / 2 拒绝，多张卡用 P1=1 P2=2）。");
        return;
      }
      await this.handleApprovalReply(userId, text);
      return;
    }

    // Pending question cards for the CURRENT session: same policy. Slash
    // commands also bypass.
    const questions = (this.pendingQuestions.get(userId) ?? []).filter(
      (c) => c.sessionId === user.sessionId,
    );
    if (!bypassCard && questions.length > 0) {
      if (text === null || text === "") {
        await this.sendReply(userId, "⚠️ 当前有提问卡待处理，请用文本回复（数字或自定义文字，例如 `Q1=1` 或 `Q1-我的想法`）。");
        return;
      }
      await this.handleQuestionReply(userId, text);
      return;
    }

    // Auto-flush cached outbound on any user message — except an explicit
    // `/next`, which owns the flush below so its result reply is not
    // duplicated by the auto path.
    const isNext = parseNextCommand(text);
    if (!isNext && this.outboundCache.length > 0) {
      await this.flushPending(userId);
    }

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);

    if (text) {
      if (isNext) {
        await this.flushPending(userId);
        return;
      }

      // DSH native command dispatch (plan / goal / compact / ...).
      // Probes the host's `ctx.commands` registry; if the leading-slash
      // name is registered for this session, the native handler runs and
      // its settled CommandExecution renders as a WeChat reply. Anything
      // else (no registry, shape not registered, agent not yet ensured)
      // returns `false` and the local whitelist / forwarding path takes
      // over unchanged. This is the only entry point that talks to the
      // native registry — keep it isolated so a future host change
      // cannot leak through the slash parser.
      if (await this.tryNativeCommand(user, userId, text)) return;

      if (parseHelpCommand(text)) {
        // Augment /help with whatever the host's `ctx.commands` has
        // registered so users see the full command surface — not just
        // the local whitelist. Native descriptors that overlap with
        // local entries are de-duplicated inside `formatHelp`.
        await this.sendReply(userId, formatHelp(await this.listNativeCommandsForHelp(user)));
        return;
      }

      const silent = parseSilentCommand(text);
      if (silent) {
        await this.handleSilentCommand(userId, silent.mode);
        return;
      }

      const notifyCmd = parseNotifyCommand(text);
      if (notifyCmd) {
        await this.handleNotifyCommand(userId, notifyCmd);
        return;
      }

      const status = parseStatusCommand(text);
      if (status) {
        await this.sendReply(userId, await this.formatStatus(user));
        return;
      }

      const stop = parseStopCommand(text);
      if (stop) {
        await this.handleStopCommand(userId, user);
        return;
      }

      const rp = parseRejectPermissionCommand(text);
      if (rp) {
        await this.rejectAllApprovals(userId);
        return;
      }

      const rq = parseRejectQuestionCommand(text);
      if (rq) {
        await this.rejectPendingQuestion(userId);
        return;
      }

      const wsCmd = parseWorkspaceCommand(text);
      if (wsCmd) {
        await this.handleWorkspaceCommand(userId, wsCmd);
        return;
      }

      const sCmd = parseSessionCommand(text);
      if (sCmd) {
        await this.handleSessionCommand(userId, sCmd);
        return;
      }

      const pCmd = parsePresetCommand(text);
      if (pCmd) {
        await this.handlePresetCommand(userId, pCmd);
        return;
      }

      const mCmd = parseModelCommand(text);
      if (mCmd) {
        await this.handleModelCommand(userId, mCmd);
        return;
      }

      const permCmd = parsePermCommand(text);
      if (permCmd) {
        await this.handlePermCommand(userId, permCmd);
        return;
      }

      const reasoningCmd = parseReasoningCommand(text);
      if (reasoningCmd) {
        await this.handleReasoningCommand(userId, reasoningCmd);
        return;
      }

      const enterCmd = parseEnterCommand(text);
      if (enterCmd) {
        await this.handleEnterCommand(userId, enterCmd);
        return;
      }

      const historyCmd = parseHistoryCommand(text);
      if (historyCmd) {
        await this.handleHistoryCommand(userId, historyCmd, user);
        return;
      }
      // Invalid /history attempt (e.g. /history abc) — show usage instead of forwarding.
      if (isHistoryCommandAttempt(text)) {
        await this.sendReply(userId, `⚠️ 用法: /history [数量]（1-${HISTORY_MAX}，默认 5）例如 /history 10`);
        return;
      }

      // Unrecognized slash command — hint, then forward to the agent.
      const slashHint = detectUnknownSlashCommand(text);
      if (slashHint) {
        await this.sendReply(userId, `⚠️ 未知命令 ${slashHint}，已作为文本转发给 agent。发送 /help 查看可用命令。`);
      }
    }

    await this.forwardToAgent(user, msg);
  }

  private async forwardToAgent(user: UserState, msg: WeixinMessage): Promise<void> {
    const agent = await this.agents.ensure(user);
    if (!agent) {
      await this.sendReply(user.userId, "⚠️ 无法创建/恢复 DSH 会话，请检查 DSH 日志。");
      return;
    }
    this.state.update(user.userId, { sessionId: user.sessionId });
    this.trackWatchedSession(user.userId, user.sessionId);

    const tempDir = path.join(this.config.storageDir, "tempfile");
    const blocks = await weixinMessageToPrompt(msg, this.config.cdnBaseUrl, (m) => this.log(m), tempDir);
    // Give the message an explicit id so its `user/message` echo can be
    // recognized as WeChat-originated (and mark the session's source).
    const messageId = `wx-msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.markWechatMessage(messageId);
    this.markSessionSource(user.sessionId, "wechat");
    // Busy-time delivery follows the DSH `ui-conversation.busyEnter` setting
    // (the GUI's 「繁忙时 Enter 键行为」 row): while the agent is running,
    // `queue` keeps the historical follow-up-turn behavior and `steer`
    // splices the message into the running turn at its nearest step
    // boundary. Idle agents always take the ordinary queue path — the same
    // "idle Enter = Queue" rule the GUI composer applies. A steer whose
    // window already closed degrades to the next waking queue turn inside
    // AgentLoop, so neither mode can lose the message.
    const mode = agent.status === "running" ? this.ops.busyEnter() : "queue";
    this.agents.followup(agent, blocks, messageId, mode);
  }

  // ─── Outbound: DSH → WeChat ───

  /**
   * Handle one session event for a WeChat-bound session.
   * `assistant/message` → send (or buffer in silent mode);
   * `turn/end` → flush the silent buffer.
   * (Approval/question cards are frame-driven via handleMuxFrame, not
   * session events — this listener only carries agent output.)
   *
   * NOTE: SessionEvent is the wrapped `{ type, seq, time, data }` shape —
   * the message lives in `event.data.message`, NOT at the top level.
   */
  handleSessionEvent(sessionId: string, event: { type: string; [k: string]: unknown }): void {
    // Mark the message source BEFORE the agent assembles its prompt.
    // Agent followups (WeChat AND GUI) go through `inbox.append` →
    // `session.append('agent/inbox/spliced')` — this event is emitted at
    // ENQUEUE time, i.e. before the agent claims the message and assembles
    // the system prompt (preStep). WeChat-injected messages carry a
    // `wx-msg-` id prefix; anything else in a next-turn splice is a GUI
    // (or other-surface) message, so the surface marker is correct at
    // assembly time instead of one turn late.
    if (event.type === "agent/inbox/spliced") {
      const data = event.data as { target?: string; inserted?: Array<{ id?: string }> };
      if (data?.target === "next-turn") {
        const inserted = data.inserted ?? [];
        // Only update the surface marker when the splice actually carries new
        // messages. A pure deletion (`inserted.length === 0`, `removedCount > 0`)
        // is the agent-loop's `inbox.claim` pulling the message out of
        // next-turn for processing — it would otherwise overwrite the just-
        // written "wechat" marker with "gui" before prompt assembly reads it
        // (see commit history: this masked WeChat→GUI as "gui" for every turn).
        if (inserted.length > 0) {
          const isWechat = inserted.some(
            (m) => typeof m?.id === "string" && m.id.startsWith("wx-msg-"),
          );
          this.markSessionSource(sessionId, isWechat ? "wechat" : "gui");
        }
        // Trigger the native "正在输入" indicator for WeChat-bound turns.
        // Any next-turn splice on a WeChat-bound session means the agent is
        // about to run (agent.status flips to "running") — show typing
        // regardless of whether the trigger message came from WeChat or the
        // GUI; the WeChat-bound user is waiting either way. The pure-claim
        // splice is included too: agent.status is already "running" by then
        // and `beginTyping` is idempotent.
        const typingUser = this.userForAgent(sessionId);
        if (typingUser) this.beginTyping(typingUser.userId, sessionId);
      }
    }

    // Track last user-prompt activity for every session (not only bound
    // ones) — the `/s list` recency source, mirroring the GUI sidebar.
    if (event.type === "user/message") {
      const data = event.data as { source?: { kind?: string }; id?: string };
      if (data?.source?.kind === "user") {
        this.lastActivityBySession.set(
          sessionId,
          typeof event.time === "number" ? event.time : Date.now(),
        );
        // Fallback source marking (the authoritative one happens on
        // agent/inbox/spliced above; this echo is emitted AFTER assembly,
        // so it only corrects sessions whose splice event was missed).
        const id = typeof data.id === "string" ? data.id : undefined;
        const isWechatEcho = id !== undefined && id.startsWith("wx-msg-");
        if (isWechatEcho) {
          // Defensive cleanup; the marker was already set at followup time.
          this.wechatMessageIds.delete(id);
        } else {
          this.markSessionSource(sessionId, "gui");
        }
      }
    }

    // Track last assistant text for cross-session completion preview (for any session)
    if (event.type === "assistant/message") {
      const data = event.data as { message?: { content?: Array<{ type: string; text?: string }> } };
      const text = (data?.message?.content ?? [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");
      if (text) this.lastAssistantTextBySession.set(sessionId, text);
    }

    const user = this.userForAgent(sessionId);
    if (!user) {
      if (event.type === "turn/end") {
        void this.notifyCrossSessionTurnEnd(sessionId);
      }
      return;
    }

    if (event.type === "turn/end") {
      void (async () => {
        const recipients = await this.resolveCrossSessionRecipients(sessionId);
        for (const r of recipients) {
          if (r.userId === user.userId) continue;
          if (!this.shouldNotifyCrossSession(r.userId)) continue;
          const ctx = await this.sessionContextLabel(sessionId);
          const preview = this.lastAssistantTextBySession.get(sessionId);
          const suffix = preview ? "\n> " + preview.slice(0, 80) + (preview.length > 80 ? "…" : "") : "";
          const body = ctx + "\n✅ 任务已完成" + suffix + "\n发送 /session switch <编号> 切换查看。";
          if (!this.botReady()) continue;
          const set = this.notifiedCrossSessionTurns.get(r.userId) ?? new Set<string>();
          if (set.has(sessionId)) continue;
          set.add(sessionId);
          this.notifiedCrossSessionTurns.set(r.userId, set);
          void this.sendReply(r.userId, body).catch(() => {});
          setTimeout(() => this.notifiedCrossSessionTurns.get(r.userId)?.delete(sessionId), 30_000);
        }
      })();
    }

    switch (event.type) {
      case "assistant/message": {
        const data = event.data as { message?: { content?: Array<{ type: string; text?: string }> } };
        const text = (data?.message?.content ?? [])
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("\n");
        if (!text) return;
        // Typing indicator stays on through the whole turn — we do NOT
        // cancel here. agent.status is still "running" while text is being
        // produced; the indicator mirrors that status and is only removed
        // on turn/end / agent/error / plugin stop.
        if (user.silent) {
          const buffer = this.silentBuffers.get(sessionId) ?? [];
          buffer.push(text);
          this.silentBuffers.set(sessionId, buffer);
        } else {
          void this.sendReply(user.userId, text);
        }
        break;
      }
      case "turn/end": {
        const buffer = this.silentBuffers.get(sessionId);
        if (buffer && buffer.length > 0) {
          this.silentBuffers.delete(sessionId);
          // Silent mode: only the last text of the turn reaches WeChat.
          void this.sendReply(user.userId, buffer[buffer.length - 1]!);
        }
        // Turn finished → agent.status flips back to "idle". Always clear
        // the typing indicator here, regardless of whether any text was
        // produced.
        this.endTyping(user.userId, "turn-end");
        this.clearCrossSessionTurnNotified(user.userId, sessionId);
        break;
      }
    }
  }

  /** Notify the bound user of an agent error. */
  handleAgentError(agentId: string, error: unknown): void {
    const user = this.userForAgent(agentId);
    if (!user) {
      void this.notifyCrossSessionError(agentId, error);
      return;
    }
    this.endTyping(user.userId, "agent-error");
    void this.sendReply(user.userId, `⚠️ Agent 出错: ${String(error)}`).catch(() => {});
    void this.notifyCrossSessionError(agentId, error);
  }

  // ─── Mux frame stream: approval/question cards (GUI-equivalent mirror) ───

  /**
   * Subscribe to the apiproxy mux frame stream (all sessions). On open the
   * stream replays every still-pending approval/question frame with its
   * rpcId verbatim, so a late-connecting or reconnecting WeChat side always
   * recovers the pending cards. Reconnect with a small delay on failure.
   */
  attachMux(apiProxy: ApiProxySurface): void {
    this.apiProxy = apiProxy;
    if (this.muxStopped) return;
    const events = (apiProxy as { events?: unknown }).events as
      | {
          mux(
            request: { rpcId: string; payload: { since?: Record<string, number> } },
            signal: AbortSignal,
          ): AsyncIterable<{
            type: "server-request";
            rpcId: string;
            method: string;
            payload: { type: string; [k: string]: unknown };
          }>;
        }
      | undefined;
    if (!events?.mux) {
      console.warn("[dsh-wechat] apiProxy.events.mux unavailable; approval/question cards disabled");
      return;
    }
    if (this.muxLoopStarted) {
      this.log("mux already running; apiProxy updated");
      return;
    }
    this.muxLoopStarted = true;
    this.log("mux loop starting");

    const loop = async (): Promise<void> => {
      while (!this.muxStopped) {
        try {
          const abort = new AbortController();
          this.muxAbort = abort;
          const frames = events.mux({ rpcId: `wx-mux-${Date.now().toString(36)}`, payload: {} }, abort.signal);
          let opened = false;
          for await (const frame of frames) {
            if (abort.signal.aborted || this.muxStopped) break;
            if (!opened) {
              opened = true;
              this.log("mux stream opened");
            }
            this.handleMuxFrame(frame);
          }
          if (this.muxStopped) return;
          if (opened) this.log("mux stream ended; reopening in 2s");
          await new Promise((r) => setTimeout(r, 2000));
        } catch (err) {
          if (this.muxStopped) return;
          console.error(`[dsh-wechat] mux stream error: ${String(err)}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };
    void loop();
  }

  /** Stop the mux subscription (plugin dispose only — not WeChat reconnect). */
  stopMux(): void {
    this.muxStopped = true;
    this.muxAbort?.abort();
    this.muxAbort = null;
  }

  private handleMuxFrame(frame: {
    type: "server-request";
    rpcId: string;
    method: string;
    payload: { type: string; [k: string]: unknown };
  }): void {
    const payload = frame.payload;
    switch (payload.type) {
      case "approval/requested": {
        const sessionId = String(payload.sessionId ?? "");
        const approvalId = String(payload.approvalId ?? "");
        const toolName = String(payload.toolName ?? "?");
        if (!frame.rpcId || !sessionId || !approvalId) return;
        const userId = this.recipientForSession(sessionId);
        if (!userId) {
          this.log(`mux approval/requested ignored (no WeChat peer for session ${sessionId})`);
          return;
        }
        const card: PendingApproval = {
          rpcId: frame.rpcId,
          sessionId,
          approvalId,
          userId,
          toolName,
          reason: typeof payload.reason === "string" ? payload.reason : undefined,
          askedAt: Date.now(),
          timer: setTimeout(() => {
            this.removeApprovalCard(userId, frame.rpcId);
            void this.sendReply(
              userId,
              `⏰ 权限卡超时未回复（${toolName}），已移除；可在 DSH 界面继续处理。`,
            ).catch(() => {});
          }, this.config.cardTimeoutMs),
        };
        const list = this.pendingApprovals.get(userId) ?? [];
        list.push(card);
        this.pendingApprovals.set(userId, list);
        // Show the card immediately only when it belongs to the user's
        // current session; otherwise notify once and flush on switch.
        // Unified cross-session switch gates the notification.
        // The typing indicator stays on through card waits — agent.status
        // is still "running" until turn/end.
        const userState = this.state.getUser(userId);
        if (userState?.sessionId === sessionId) {
          void this.sendApprovalCard(userId, card, list.length).catch(() => {});
        } else {
          if (!this.shouldNotifyCrossSession(userId)) {
          } else {
            void this.notifyCardPending(userId, sessionId).catch(() => {});
          }
        }
        break;
      }
      case "approval/resolved": {
        const approvalId = String(payload.approvalId ?? "");
        const outcome = String(payload.outcome ?? "");
        for (const [userId, list] of [...this.pendingApprovals.entries()]) {
          const entry = list.find((c) => c.approvalId === approvalId);
          if (!entry) continue;
          const toolName = entry.toolName;
          this.removeApprovalCard(userId, entry.rpcId);
          if (!this.shouldNotifyCrossSession(userId)) break;
          const label = outcome === "allowed-once" ? "✅ 已允许" : outcome === "rejected" ? "⛔ 已拒绝" : "🚫 已取消";
          void this.sendReply(userId, `🔒 权限请求结果：${label}（${toolName}）`).catch(() => {});
          break;
        }
        break;
      }
      case "question/requested": {
        const sessionId = String(payload.sessionId ?? "");
        const questions = payload.questions as AskUserQuestionItem[] | undefined;
        if (!frame.rpcId || !sessionId || !Array.isArray(questions) || questions.length === 0) return;
        const userId = this.recipientForSession(sessionId);
        if (!userId) {
          this.log(`mux question/requested ignored (no WeChat peer for session ${sessionId})`);
          return;
        }
        const card: PendingQuestion = {
          rpcId: frame.rpcId,
          sessionId,
          userId,
          items: questions,
          askedAt: Date.now(),
          timer: setTimeout(() => {
            this.removeQuestionCard(userId, frame.rpcId);
            void this.sendReply(userId, "⏰ 提问卡超时未回复，已移除；可在 DSH 界面继续回答。").catch(() => {});
          }, this.config.cardTimeoutMs),
        };
        const list = this.pendingQuestions.get(userId) ?? [];
        list.push(card);
        this.pendingQuestions.set(userId, list);
        // Same current-session policy as approval cards. Unified switch gates notification.
        // Typing indicator stays on through card waits — agent.status is still "running".
        const userState = this.state.getUser(userId);
        if (userState?.sessionId === sessionId) {
          void this.sendQuestionCard(userId, card, questions, list.length).catch(() => {});
        } else {
          if (!this.shouldNotifyCrossSession(userId)) {
          } else {
            void this.notifyCardPending(userId, sessionId).catch(() => {});
          }
        }
        break;
      }
      case "question/resolved": {
        const questionRpcId = String(payload.questionRpcId ?? "");
        const outcome = String(payload.outcome ?? "");
        for (const [userId, list] of [...this.pendingQuestions.entries()]) {
          const entry = list.find((c) => c.rpcId === questionRpcId);
          if (!entry) continue;
          this.removeQuestionCard(userId, entry.rpcId);
          if (!this.shouldNotifyCrossSession(userId)) break;
          void this.sendReply(userId, outcome === "answered" ? "✅ 提问已回答。" : "🚫 提问已取消。").catch(() => {});
          break;
        }
        break;
      }
    }
  }

  /**
   * Session provenance label for a card: which workspace and which session
   * the request belongs to (`📂 <工作区> · 💬 <会话标题>`), so a card for a
   * non-current session is identifiable without switching.
   */
  private async sessionContextLabel(sessionId: string): Promise<string> {
    const sessions = await this.ops.listSessions();
    const record = sessions.find((r) => r.header.id === sessionId);
    const workspace = record?.header.cwd?.split(/[\\/]/).pop() ?? "?";
    const title = record
      ? (await this.ops.readSessionTitle(sessionId)) ?? sessionId.slice(0, 8)
      : sessionId.slice(0, 8);
    return `📂 ${workspace} · 💬 ${title}`;
  }

  /** Send one mirrored approval card with its session provenance header. */
  private async sendApprovalCard(userId: string, card: PendingApproval, count: number): Promise<void> {
    const context = await this.sessionContextLabel(card.sessionId);
    const note = this.isBoundSession(card.sessionId)
      ? ""
      : `\n\n（会话 ${card.sessionId.slice(0, 12)} — 未绑定微信，可直接在此处理）`;
    await this.sendReply(userId, `${context}\n${formatApprovalCard(card, count, count)}${note}`);
  }

  /** Send one mirrored question card with its session provenance header. */
  private async sendQuestionCard(
    userId: string,
    card: PendingQuestion,
    questions: AskUserQuestionItem[],
    count: number,
  ): Promise<void> {
    const context = await this.sessionContextLabel(card.sessionId);
    const header = count > 1 ? `❓ 提问卡 ${count}/${count}` : "❓ 提问";
    await this.sendReply(userId, `${header}\n${context}\n${formatQuestionForWeChat(questions)}`);
  }

  /**
   * Tell the user a non-current session has pending cards, once per session
   * (a burst of cards for the same session yields a single notice). The
   * notice names the session; switching into it flushes the cards.
   *
   * The dedupe mark is only set when the notice can actually be delivered:
   * right after a restart there is no context token yet (the bridge cannot
   * push until the user sends the first message), and marking the session
   * anyway would swallow every later notice for it.
   */
  private async notifyCardPending(userId: string, sessionId: string): Promise<void> {
    const notified = this.notifiedCardSessions.get(userId) ?? new Set<string>();
    if (notified.has(sessionId)) return;
    if (!this.botReady()) return;
    notified.add(sessionId);
    this.notifiedCardSessions.set(userId, notified);
    const context = await this.sessionContextLabel(sessionId);
    const approvals = (this.pendingApprovals.get(userId) ?? []).filter((c) => c.sessionId === sessionId).length;
    const questions = (this.pendingQuestions.get(userId) ?? []).filter((c) => c.sessionId === sessionId).length;
    const kinds = [
      approvals > 0 ? `${approvals} 张权限卡` : "",
      questions > 0 ? `${questions} 张提问卡` : "",
    ].filter(Boolean).join("、");
    await this.sendReply(
      userId,
      `${context}\n🔔 有 ${kinds}待处理，发送 /session switch <编号> 切换到该会话后查看。`,
    );
  }

  /**
   * Drop the notified mark for (userId, sessionId) once no cards are pending
   * for that session — so the next batch of cards produces a fresh WeChat
   * notification. Burst dedupe within a single batch is preserved: this only
   * clears when the last card of a session is removed (any path: GUI/WeChat
   * resolve, timeout, /rp, /rq). Called from removeApprovalCard /
   * removeQuestionCard so every removal path is covered automatically.
   */
  private clearNotifiedIfNoPending(userId: string, sessionId: string): void {
    const approvals = (this.pendingApprovals.get(userId) ?? [])
      .filter((c) => c.sessionId === sessionId).length;
    const questions = (this.pendingQuestions.get(userId) ?? [])
      .filter((c) => c.sessionId === sessionId).length;
    if (approvals === 0 && questions === 0) {
      this.notifiedCardSessions.get(userId)?.delete(sessionId);
    }
  }

  /**
   * Whether cross-session notifications are enabled (single-user: global only).
   */
  private shouldNotifyCrossSession(_userId: string): boolean {
    return this.config.crossSessionNotify === true;
  }

  private async resolveCrossSessionRecipients(sessionId: string): Promise<UserState[]> {
    const record = await this.ops.findSessionRecord(sessionId);
    if (!record) return [];
    const recipients: UserState[] = [];
    const seen = new Set<string>();
    for (const user of this.state.all()) {
      if (user.watchedSessions?.includes(sessionId)) {
        recipients.push(user);
        seen.add(user.userId);
      }
    }
    if (recipients.length > 0) return recipients;
    if (record.header.cwd) {
      const workspaces = this.ops.listWorkspaces();
      const owningWs = workspaces.find((w) => w.path === record.header.cwd) ?? workspaces.find((w) => w.sessionIds.includes(sessionId));
      if (owningWs) {
        for (const user of this.state.all()) {
          if (!seen.has(user.userId) && user.cwd === owningWs.path) {
            recipients.push(user);
            seen.add(user.userId);
          }
        }
        if (recipients.length > 0) return recipients;
      }
    }
    const first = this.state.all()[0];
    if (first && !seen.has(first.userId)) recipients.push(first);
    return recipients;
  }

  private async notifyCrossSessionTurnEnd(sessionId: string): Promise<void> {
    const recipients = await this.resolveCrossSessionRecipients(sessionId);
    if (recipients.length === 0) return;
    const context = await this.sessionContextLabel(sessionId);
    const preview = this.lastAssistantTextBySession.get(sessionId);
    const previewSuffix = preview ? "\n> " + preview.slice(0, 80) + (preview.length > 80 ? "…" : "") : "";
    const body = context + "\n✅ 任务已完成" + previewSuffix + "\n发送 /session switch <编号> 切换查看。";
    for (const user of recipients) {
      if (user.sessionId === sessionId) continue;
      if (!this.shouldNotifyCrossSession(user.userId)) continue;
      if (!this.botReady()) continue;
      const set = this.notifiedCrossSessionTurns.get(user.userId) ?? new Set<string>();
      if (set.has(sessionId)) continue;
      set.add(sessionId);
      this.notifiedCrossSessionTurns.set(user.userId, set);
      void this.sendReply(user.userId, body).catch(() => {});
      setTimeout(() => { this.notifiedCrossSessionTurns.get(user.userId)?.delete(sessionId); }, 30_000);
    }
  }

  private async notifyCrossSessionError(sessionId: string, error: unknown): Promise<void> {
    const recipients = await this.resolveCrossSessionRecipients(sessionId);
    if (recipients.length === 0) return;
    const context = await this.sessionContextLabel(sessionId);
    const msg = String(error).slice(0, 200);
    const body = context + "\n⚠️ 任务报错: " + msg + "\n发送 /session switch <编号> 查看。";
    for (const user of recipients) {
      if (user.sessionId === sessionId) continue;
      if (!this.shouldNotifyCrossSession(user.userId)) continue;
      if (!this.botReady()) continue;
      void this.sendReply(user.userId, body).catch(() => {});
    }
  }

  private clearCrossSessionTurnNotified(userId: string, sessionId: string): void {
    this.notifiedCrossSessionTurns.get(userId)?.delete(sessionId);
  }

  private trackWatchedSession(userId: string, sessionId: string): void {
    if (!sessionId) return;
    this.state.watchSession(userId, sessionId);
  }

  /**
   * After the user switches into `sessionId`, flush any pending cards for
   * it: show them if still pending, or — only when the user was notified
   * about this session earlier — say they are gone (timeout / handled in
   * the GUI). Ordinary switches without a notification stay silent.
   */
  private async flushPendingCardsForSession(userId: string, sessionId: string): Promise<void> {
    const wasNotified = this.notifiedCardSessions.get(userId)?.has(sessionId) ?? false;
    const approvals = (this.pendingApprovals.get(userId) ?? []).filter((c) => c.sessionId === sessionId);
    const questions = (this.pendingQuestions.get(userId) ?? []).filter((c) => c.sessionId === sessionId);

    if (approvals.length > 0 || questions.length > 0) {
      for (const card of approvals) {
        void this.sendApprovalCard(userId, card, approvals.length).catch(() => {});
      }
      for (const card of questions) {
        void this.sendQuestionCard(userId, card, card.items, questions.length).catch(() => {});
      }
    } else if (wasNotified) {
      await this.sendReply(userId, "ℹ️ 该会话的待处理卡片已在其他端处理或超时。");
    }

    // Clear the notice either way: the user has now been shown the cards
    // (or told they are gone); a new card will notify again.
    this.notifiedCardSessions.get(userId)?.delete(sessionId);
    this.clearCrossSessionTurnNotified(userId, sessionId);
  }

  /**
   * Resolve the WeChat user for a calling DSH agent id. Prefers the user
   * bound to this agent (session) id; otherwise falls back to the first
   * known user (single-user deployments are the norm). Returns undefined
   * only when no user has ever interacted with the bridge.
   */
  private resolveUserForAgent(agentId: string): UserState | undefined {
    const bound = this.userForAgent(agentId);
    if (bound) return bound;
    return this.state.all()[0];
  }

  /** The WeChat user a card for `sessionId` goes to: its bound user, else the first known user. */
  private recipientForSession(sessionId: string): string | undefined {
    return this.resolveUserForAgent(sessionId)?.userId;
  }

  private isBoundSession(sessionId: string): boolean {
    return this.userForAgent(sessionId) !== undefined;
  }

  /** Pending cards that belong to the user's *current* bound session. */
  private pendingCardsForCurrentSession(userId: string): {
    approvals: PendingApproval[];
    questions: PendingQuestion[];
  } {
    const sessionId = this.state.getUser(userId)?.sessionId;
    if (!sessionId) return { approvals: [], questions: [] };
    return {
      approvals: (this.pendingApprovals.get(userId) ?? []).filter((c) => c.sessionId === sessionId),
      questions: (this.pendingQuestions.get(userId) ?? []).filter((c) => c.sessionId === sessionId),
    };
  }

  // ─── Approval replies ───

  private async handleApprovalReply(userId: string, text: string): Promise<void> {
    const all = this.pendingApprovals.get(userId) ?? [];
    // Only the user's current session's cards are answerable from WeChat;
    // cards of other sessions are flushed when the user switches into them.
    const userState = this.state.getUser(userId);
    const list = userState?.sessionId
      ? all.filter((c) => c.sessionId === userState.sessionId)
      : all;
    if (list.length === 0) {
      if (all.length > 0) {
        await this.sendReply(userId, "💬 当前会话没有待处理的权限卡（其他会话的卡切换过去后查看）。");
      }
      return;
    }

    // Priority commands.
    if (parseRejectPermissionCommand(text)) {
      await this.rejectAllApprovals(userId);
      return;
    }

    const { decisions, warnings } = parseApprovalReply(text, list);
    const snapshot = [...list];
    for (const decision of decisions) {
      const entry = snapshot.find((c) => c.rpcId === decision.rpcId);
      if (!entry) continue;
      this.removeApprovalCard(userId, decision.rpcId);
      const outcome = decision.reply === "once" ? "allowed-once" : "rejected";
      const receipt = await this.respondApproval(entry, outcome);
      if (!receipt.accepted) {
        void this.sendReply(userId, `ℹ️ 该权限请求已在其他端处理（${receipt.reason ?? "not-pending"}）。`).catch(() => {});
      }
    }
    for (const warning of warnings) {
      void this.sendReply(userId, `⚠️ ${warning}`).catch(() => {});
    }
    if (decisions.length === 0) {
      await this.sendReply(userId, "⚠️ 无法识别的权限回复。回复 1（允许一次）/ 2（拒绝），多张卡用 P1=1 P2=2，或 /rp 全部拒绝。");
    }
  }

  private async respondApproval(
    entry: PendingApproval,
    outcome: "allowed-once" | "rejected",
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.apiProxy) return { accepted: false, reason: "apiProxy-unavailable" };
    try {
      return await this.apiProxy.respond({
        type: "client-response",
        rpcId: entry.rpcId,
        result: {
          ok: true,
          value: {
            sessionId: entry.sessionId,
            approvalId: entry.approvalId,
            outcome,
          },
        },
      });
    } catch (err) {
      console.error(`[dsh-wechat] approval respond failed: ${String(err)}`);
      return { accepted: false, reason: "error" };
    }
  }

  private removeApprovalCard(userId: string, rpcId: string): void {
    const list = this.pendingApprovals.get(userId);
    if (!list) return;
    const entry = list.find((c) => c.rpcId === rpcId);
    if (!entry) return;
    clearTimeout(entry.timer);
    const sessionId = entry.sessionId;
    const next = list.filter((c) => c.rpcId !== rpcId);
    if (next.length > 0) this.pendingApprovals.set(userId, next);
    else this.pendingApprovals.delete(userId);
    this.clearNotifiedIfNoPending(userId, sessionId);
  }

  /** `/rp` — reject every pending approval card of the current session. */
  private async rejectAllApprovals(userId: string): Promise<void> {
    const all = this.pendingApprovals.get(userId) ?? [];
    const userState = this.state.getUser(userId);
    const list = userState?.sessionId
      ? all.filter((c) => c.sessionId === userState.sessionId)
      : all;
    if (list.length === 0) {
      await this.sendReply(userId, "✅ 当前会话没有待处理的权限卡。");
      return;
    }
    for (const entry of [...list]) {
      this.removeApprovalCard(userId, entry.rpcId);
      const receipt = await this.respondApproval(entry, "rejected");
      if (!receipt.accepted) {
        void this.sendReply(userId, `ℹ️ 权限请求 ${entry.toolName} 已在其他端处理。`).catch(() => {});
      }
    }
    await this.sendReply(userId, `✅ 已拒绝 ${list.length} 张权限卡。`);
  }

  // ─── Question replies ───

  private async handleQuestionReply(userId: string, text: string): Promise<void> {
    const all = this.pendingQuestions.get(userId) ?? [];
    // Only the current session's questions are answerable from WeChat.
    const userState = this.state.getUser(userId);
    const list = userState?.sessionId
      ? all.filter((c) => c.sessionId === userState.sessionId)
      : all;
    if (list.length === 0) {
      if (all.length > 0) {
        await this.sendReply(userId, "💬 当前会话没有待处理的提问卡（其他会话的卡切换过去后查看）。");
      }
      return;
    }

    // Priority commands.
    if (parseRejectQuestionCommand(text)) {
      await this.rejectPendingQuestion(userId);
      return;
    }
    if (parseStopCommand(text)) {
      await this.rejectPendingQuestion(userId);
      const userState = this.state.getUser(userId);
      const agent = userState ? this.agents.get(userState) : undefined;
      agent?.cancel("user-stop");
      await this.sendReply(userId, "🛑 已停止任务并拒绝问题。");
      return;
    }

    // Select the target card: single card → whole text; multiple cards → P{n}= prefix.
    let entry = list[0]!;
    let answerText = text;
    const cardMatch = text.trim().match(/^P(\d+)\s*[:=]\s*([\s\S]*)$/);
    if (list.length > 1) {
      if (!cardMatch) {
        await this.sendReply(userId, `⚠️ 有 ${list.length} 张提问卡待处理。请用 P1=… 指定卡片（内容用 Qn= 语法），或 /rq 全部拒绝。`);
        return;
      }
      const index = parseInt(cardMatch[1]!, 10);
      if (index < 1 || index > list.length) {
        await this.sendReply(userId, `⚠️ 卡片编号超出范围（1-${list.length}）。`);
        return;
      }
      entry = list[index - 1]!;
      answerText = cardMatch[2]!;
    }

    const parsed = parseQuestionReply(answerText, entry.items);
    this.removeQuestionCard(userId, entry.rpcId);
    for (const warning of parsed.warnings) {
      void this.sendReply(userId, `⚠️ ${warning}`).catch(() => {});
    }
    const receipt = await this.respondQuestion(entry, buildAnswer(parsed, entry.items));
    if (!receipt.accepted) {
      void this.sendReply(userId, `ℹ️ 该提问已在其他端回答（${receipt.reason ?? "not-pending"}）。`).catch(() => {});
    }
  }

  private async respondQuestion(
    entry: PendingQuestion,
    answer: AskUserQuestionAnswer,
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.apiProxy) return { accepted: false, reason: "apiProxy-unavailable" };
    try {
      return await this.apiProxy.respond({
        type: "client-response",
        rpcId: entry.rpcId,
        result: {
          ok: true,
          value: {
            sessionId: entry.sessionId,
            answer,
          },
        },
      });
    } catch (err) {
      console.error(`[dsh-wechat] question respond failed: ${String(err)}`);
      return { accepted: false, reason: "error" };
    }
  }

  /** `/rq` — reject every pending question card of the current session. */
  private async rejectPendingQuestion(userId: string): Promise<void> {
    const all = this.pendingQuestions.get(userId) ?? [];
    const userState = this.state.getUser(userId);
    const list = userState?.sessionId
      ? all.filter((c) => c.sessionId === userState.sessionId)
      : all;
    if (list.length === 0) {
      await this.sendReply(userId, "✅ 当前会话没有待处理的问题卡。");
      return;
    }
    for (const entry of [...list]) {
      this.removeQuestionCard(userId, entry.rpcId);
      if (this.apiProxy) {
        try {
          await this.apiProxy.respond({
            type: "client-response",
            rpcId: entry.rpcId,
            result: { ok: false, error: { code: "cancelled" } },
          });
        } catch {
          // best effort
        }
      }
    }
    await this.sendReply(userId, `✅ 已拒绝 ${list.length} 张提问卡。`);
  }

  private removeQuestionCard(userId: string, rpcId: string): void {
    const list = this.pendingQuestions.get(userId);
    if (!list) return;
    const entry = list.find((c) => c.rpcId === rpcId);
    if (!entry) return;
    clearTimeout(entry.timer);
    const sessionId = entry.sessionId;
    const next = list.filter((c) => c.rpcId !== rpcId);
    if (next.length > 0) this.pendingQuestions.set(userId, next);
    else this.pendingQuestions.delete(userId);
    this.clearNotifiedIfNoPending(userId, sessionId);
  }

  // ─── Slash command handlers ───

  private async handleNotifyCommand(userId: string, cmd: NotifyCommand): Promise<void> {
    if (cmd.kind === "status") {
      const on = this.shouldNotifyCrossSession(userId) ? "on" : "off";
      await this.sendReply(userId, `🔔 跨会话通知: ${on}（已完成/报错/卡片，单用户）\n切换: /notify on|off`);
      return;
    }
    if (cmd.kind === "on") {
      this.config.crossSessionNotify = true;
      try { this.persistGlobalCrossNotify(true); } catch {}
      await this.sendReply(userId, "✅ 跨会话通知已开启。");
      return;
    }
    if (cmd.kind === "off") {
      this.config.crossSessionNotify = false;
      try { this.persistGlobalCrossNotify(false); } catch {}
      await this.sendReply(userId, "🔕 跨会话通知已关闭。");
      return;
    }
  }

  private persistGlobalCrossNotify(enabled: boolean): void {
    try {
      const cfgPath = require("node:path").join(this.config.storageDir, "config.json");
      let cur: Record<string, unknown> = {};
      try { cur = JSON.parse(require("node:fs").readFileSync(cfgPath, "utf-8")); } catch {}
      cur.crossSessionNotify = enabled;
      require("node:fs").mkdirSync(require("node:path").dirname(cfgPath), { recursive: true });
      require("node:fs").writeFileSync(cfgPath, JSON.stringify(cur, null, 2), "utf-8");
    } catch {}
  }

  private async handleSilentCommand(userId: string, mode: "on" | "off" | "status"): Promise<void> {
    const user = this.state.ensureUser(userId, this.config.cwd);
    if (mode === "on") {
      this.state.update(userId, { silent: true });
      await this.sendReply(userId, "🔇 静默模式已开启：每轮只发送最终回复。");
    } else if (mode === "off") {
      this.state.update(userId, { silent: false });
      await this.sendReply(userId, "🔊 静默模式已关闭。");
    } else {
      await this.sendReply(userId, `静默模式: ${user.silent ? "on" : "off"}（/silent on|off 切换）`);
    }
  }

  // ─── Busy-Enter delivery behavior (/enter) ───

  /**
   * `/enter` — view or switch the busy-time delivery behavior. Reads and
   * writes the DSH settings document (`ui-conversation.busyEnter`), the same
   * field the GUI General Settings 「繁忙时 Enter 键行为」 row edits, so both
   * ends always share one value. The behavior applies at delivery time: while
   * the agent is running, `queue` waits for a follow-up turn and `steer`
   * splices into the running turn.
   */
  private async handleEnterCommand(userId: string, cmd: EnterCommand): Promise<void> {
    const describe = (mode: "queue" | "steer"): string =>
      mode === "steer"
        ? "steer（插话：运行中发消息立即插入当前轮次）"
        : "queue（排队：运行中发消息等当前轮结束后新开一轮）";
    if (cmd.kind === "status") {
      await this.sendReply(
        userId,
        `⏳ 繁忙时投递: ${describe(this.ops.busyEnter())}\n切换: /enter queue|steer（与 DSH 设置「繁忙时 Enter 键行为」同步，双端共用）`,
      );
      return;
    }
    const saved = await this.ops.saveBusyEnter(cmd.target);
    const lines = [`✅ 繁忙时投递已切换: ${describe(cmd.target)}`];
    if (saved) {
      lines.push("（已写入 DSH 设置，GUI 设置页同步可见）");
    } else {
      lines.push("⚠️ 无法写入 DSH 设置（仅本次进程内生效）");
    }
    await this.sendReply(userId, lines.join("\n"));
  }

  private async handleStopCommand(userId: string, user: UserState): Promise<void> {
    const agent = this.agents.get(user);
    if (!agent) {
      await this.sendReply(userId, "⚠️ 当前没有活动的会话。");
      return;
    }
    agent.cancel("user-stop");
    await this.sendReply(userId, "🛑 已发送停止指令。");
  }

  // ─── Workspace / Session / Agent / Model commands ───

  private async handleWorkspaceCommand(userId: string, cmd: WorkspaceCommand): Promise<void> {
    const user = this.state.ensureUser(userId, this.config.cwd);
    switch (cmd.kind) {
      case "list": {
        const workspaces = this.ops.listWorkspaces();
        if (workspaces.length === 0) {
          await this.sendReply(userId, "📂 暂无工作区。可用 /workspace add <路径> 添加。");
          return;
        }
        const archived = new Set(this.ops.archivedSessionIds());
        const lines = ["📂 工作区列表（按最近使用排序）"];
        workspaces.forEach((ws, i) => {
          const current = user.cwd === ws.path ? " ◀ 当前" : "";
          const visibleCount = ws.sessionIds.filter((id) => !archived.has(id)).length;
          lines.push(`${i + 1}. ${ws.title} — ${ws.path}（${visibleCount} 会话）${current}`);
        });
        lines.push("", "切换: /workspace switch <编号|路径>");
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "status": {
        await this.sendReply(userId, `📂 当前工作区: ${user.cwd}（会话 ${user.sessionId || "未绑定"}）`);
        return;
      }
      case "add": {
        const ws = await this.ops.createWorkspace(cmd.path);
        if (!ws) {
          await this.sendReply(userId, `⚠️ 无法创建工作区: ${cmd.path}（目录不存在或不是目录）`);
          return;
        }
        const restored = await this.switchUserWorkspace(user, ws.path);
        await this.sendReply(userId, await this.formatWorkspaceSwitchReply("已添加并切换到工作区", ws.title, ws.path, restored));
        return;
      }
      case "switch": {
        let ws;
        if (/^\d+$/.test(cmd.target)) {
          const workspaces = this.ops.listWorkspaces();
          const index = parseInt(cmd.target, 10);
          if (index < 1 || index > workspaces.length) {
            await this.sendReply(userId, `⚠️ 编号超出范围（1-${workspaces.length}）。`);
            return;
          }
          ws = workspaces[index - 1];
        } else {
          ws = await this.ops.resolveWorkspaceByPath(cmd.target);
          if (!ws) {
            const created = await this.ops.createWorkspace(cmd.target);
            if (created) ws = created;
          }
        }
        if (!ws) {
          await this.sendReply(userId, `⚠️ 找不到工作区: ${cmd.target}`);
          return;
        }
        const restored = await this.switchUserWorkspace(user, ws.path);
        await this.sendReply(userId, await this.formatWorkspaceSwitchReply("已切换到工作区", ws.title, ws.path, restored));
        return;
      }
    }
  }

  /**
   * Rebind the user to the workspace's most recent visible session.
   * Returns the restored session id, or "" when the workspace has none
   * (the next user message will create one — this method does not mint).
   */
  private async switchUserWorkspace(user: UserState, workspacePath: string): Promise<string> {
    user.cwd = workspacePath;
    user.cwdExplicit = true;
    user.sessionId = "";
    // Prefer the workspace's newest non-archived candidate session.
    const ws = this.ops.listWorkspaces().find((w) => w.path === workspacePath);
    const archived = new Set(this.ops.archivedSessionIds());
    const candidate = ws?.sessionIds.find((id) => !archived.has(id));
    if (candidate) {
      user.sessionId = candidate;
    }
    this.state.update(user.userId, { cwd: workspacePath, cwdExplicit: true, sessionId: user.sessionId });
    this.trackWatchedSession(user.userId, user.sessionId);
    return user.sessionId;
  }

  /** Two-line workspace switch/add reply: workspace row + restored session. */
  private async formatWorkspaceSwitchReply(
    verb: string,
    title: string,
    path: string,
    sessionId: string,
  ): Promise<string> {
    const head = `✅ ${verb}: ${title} — ${path}`;
    if (!sessionId) {
      return `${head}\n💬 该工作区暂无会话，发送消息将创建`;
    }
    return `${head}\n💬 已恢复会话: ${await this.formatSessionLabel(sessionId)}`;
  }

  /**
   * WeChat-facing session label: cleaned title (id prefix fallback) + full id.
   */
  private async formatSessionLabel(sessionId: string): Promise<string> {
    const raw = (await this.ops.readSessionTitle(sessionId)) ?? sessionId.slice(0, 12);
    return `${cleanSessionTitle(raw)}（${sessionId}）`;
  }

  private async handleSessionCommand(userId: string, cmd: SessionCommand): Promise<void> {
    const user = this.state.ensureUser(userId, this.config.cwd);
    switch (cmd.kind) {
      case "list": {
        const sessions = await this.ops.listSessions();
        if (sessions.length === 0) {
          await this.sendReply(userId, "💬 暂无会话。发送消息即可创建第一个会话。");
          return;
        }
        // `/s list current` narrows to sessions of the current working
        // directory; plain `/s list` shows every session.
        const scoped = cmd.scope === "current"
          ? sessions.filter((r) => r.header.cwd === user.cwd)
          : sessions;
        if (scoped.length === 0) {
          await this.sendReply(userId, `💬 当前工作目录（${user.cwd}）下暂无会话。发送消息即可创建第一个会话。`);
          return;
        }
        // Cold-start recency recovery: sessions without an in-memory activity
        // record (e.g. right after a restart) read their last user-prompt
        // time from the raw log, in parallel; results are cached afterwards.
        await Promise.all(
          scoped.map(async (r) => {
            if (this.lastActivityBySession.has(r.header.id)) return;
            const t = await this.ops.lastUserMessageTime(r.header.id);
            if (t !== undefined) this.lastActivityBySession.set(r.header.id, t);
          }),
        );
        const recent = scoped
          .sort((a, b) => this.sessionActivityTime(b) - this.sessionActivityTime(a))
          .slice(0, 20);
        const lines = [cmd.scope === "current"
          ? `💬 最近会话（${user.cwd}，/session switch <编号> 切换）`
          : "💬 最近会话（按最近活动排序，/session switch <编号> 切换）"];
        // Pass each row's already-known cwd so we don't re-query the
        // session roster per line. Reads run in parallel; session-log.cjs
        // caches by (path, size, mtime) so a second `/s list` is a stat.
        const [titles, presetIds, presets] = await Promise.all([
          Promise.all(recent.map((r) => this.ops.readSessionTitle(r.header.id))),
          Promise.all(recent.map((r) => this.ops.resolveSessionPreset(r.header.id, r.header.cwd))),
          this.ops.listPresets(),
        ]);
        for (let i = 0; i < recent.length; i++) {
          const record = recent[i]!;
          const marker = record.header.id === user.sessionId ? " ◀ 当前" : "";
          const title = cleanSessionTitle(titles[i] ?? record.header.id.slice(0, 12));
          const when = this.formatRelativeTime(this.sessionActivityTime(record));
          const presetId = presetIds[i];
          const presetLabel = presetId
            ? (presets.find((p) => p.id === presetId)?.name ?? presetId)
            : undefined;
          // One line per entry: WeChat renders `\n` in BOT text unreliably
          // (entries collapse together), so every field rides the same line
          // and each entry stays identifiable by its `N.` prefix.
          lines.push(
            `${i + 1}. ${title}${marker} — ${record.header.cwd ?? "?"} · ${when}${presetLabel ? ` · Preset:${presetLabel}` : ""}`,
          );
        }
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "switch": {
        const sessions = await this.ops.listSessions();
        const recent = sessions.sort((a, b) => this.sessionActivityTime(b) - this.sessionActivityTime(a));
        const index = cmd.index;
        if (index < 1 || index > recent.length) {
          await this.sendReply(userId, `⚠️ 编号超出范围（1-${recent.length}）。`);
          return;
        }
        const record = recent[index - 1]!;
        user.sessionId = record.header.id;
        if (record.header.cwd) {
          user.cwd = record.header.cwd;
          user.cwdExplicit = true;
        }
        this.state.update(user.userId, { sessionId: user.sessionId, cwd: user.cwd, cwdExplicit: user.cwdExplicit });
        this.trackWatchedSession(user.userId, user.sessionId);
        const agent = await this.agents.ensure(user);
        const label = await this.formatSessionLabel(record.header.id);
        await this.sendReply(userId, `✅ 已切换到会话 ${label} — ${record.header.cwd ?? "?"}${agent ? `，Agent ${agent.status}` : ""}。`);
        // Flush any pending cards for the session just switched into
        // (notified earlier, or silently when nothing was pending).
        await this.flushPendingCardsForSession(user.userId, user.sessionId);
        return;
      }
      case "new": {
        // GUI-equivalent "reuse-or-create its blank session": if the current
        // session is already blank (created but never spoken to), stay on it;
        // otherwise reuse the newest blank session in the current cwd; only
        // when none exists create a fresh one.
        if (user.sessionId) {
          const currentActivity = await this.ops.lastUserMessageTime(user.sessionId);
          if (currentActivity === undefined) {
            const agent = this.agents.get(user);
            await this.sendReply(userId, `✅ 已在空白会话（${user.sessionId.slice(0, 12)}）${agent ? `，Agent ${agent.status}` : ""}。`);
            return;
          }
        }
        const blank = await this.findBlankSession(user.cwd, user.sessionId);
        if (blank) {
          user.sessionId = blank;
          this.state.update(user.userId, { sessionId: user.sessionId });
          this.trackWatchedSession(user.userId, blank);
          const agent = await this.agents.ensure(user);
          await this.sendReply(userId, `✅ 已复用空白会话 ${blank.slice(0, 12)}（${user.cwd}）${agent ? `，Agent ${agent.status}` : ""}。`);
          return;
        }
        user.sessionId = "";
        this.state.update(user.userId, { sessionId: "" });
        const agent = await this.agents.ensure(user);
        this.state.update(user.userId, { sessionId: user.sessionId });
        this.trackWatchedSession(user.userId, user.sessionId);
        await this.sendReply(userId, `✅ 已创建新会话（${user.cwd}）${agent ? "，Agent 就绪" : "，但 Agent 创建失败"}。`);
        return;
      }
      case "status": {
        const agent = this.agents.get(user);
        await this.sendReply(userId, `💬 会话: ${user.sessionId || "未绑定"}\n工作区: ${user.cwd}\nAgent: ${agent ? agent.status : "未加载"}`);
        return;
      }
    }
  }

  /**
   * Find the newest blank (never-spoken-to) session in `cwd`, mirroring the
   * GUI's "reuse-or-create its blank session" behavior. A blank session is
   * one with no `user/message` event in its log — created by a previous
   * "new session" that the user never used. Archived sessions are already
   * filtered by `listSessions()`. `excludeId` skips the caller's current
   * session (the caller handles "already blank" separately).
   */
  private async findBlankSession(cwd: string, excludeId?: string): Promise<string | undefined> {
    const sessions = (await this.ops.listSessions())
      .filter((r) => r.header.cwd === cwd && r.header.id !== excludeId)
      .sort((a, b) => b.header.createdAt - a.header.createdAt);
    for (const record of sessions) {
      const activity = await this.ops.lastUserMessageTime(record.header.id);
      if (activity === undefined) return record.header.id;
    }
    return undefined;
  }

  private async handlePresetCommand(userId: string, cmd: PresetCommand): Promise<void> {
    const user = this.state.ensureUser(userId, this.config.cwd);
    switch (cmd.kind) {
      case "list": {
        const presets = (await this.ops.listPresets()).filter((p) => !p.broken);
        if (presets.length === 0) {
          await this.sendReply(userId, "🤖 暂无可用 Preset。");
          return;
        }
        const current = this.ops.defaultPresetId();
        const lines = ["🤖 可用 Preset（/preset switch <名称|编号>，写入 DSH 默认设置）"];
        presets.forEach((preset, i) => {
          const marker = preset.id === current ? " ◀ 当前默认" : "";
          lines.push(`${i + 1}. ${preset.name ?? preset.id} — ${preset.id}${marker}`);
          if (preset.description) lines.push(`   ${preset.description}`);
        });
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "switch": {
        const presets = (await this.ops.listPresets()).filter((p) => !p.broken);
        let preset;
        if (/^\d+$/.test(cmd.target)) {
          const index = parseInt(cmd.target, 10);
          preset = presets[index - 1];
          if (!preset) {
            await this.sendReply(userId, `⚠️ 编号超出范围（1-${presets.length}）。`);
            return;
          }
        } else {
          preset = presets.find((p) => p.id === cmd.target || p.name === cmd.target);
          if (!preset) {
            await this.sendReply(userId, `⚠️ 未知 Preset: ${cmd.target}。用 /preset list 查看。`);
            return;
          }
        }
        // Write the DSH settings document — the same default the GUI settings
        // page edits, so both sides see the same selection.
        const saved = await this.ops.saveDefaultPreset(preset.id);
        // Apply to the live session only while it has produced nothing.
        const agent = this.agents.get(user);
        const empty = agent ? (agent as { session?: { events?: unknown[] } }).session?.events?.length === 0 : true;
        let applied = "";
        if (agent && empty) {
          const ok = await this.ops.recomposeAgent(
            (agent as { ctx?: unknown }).ctx,
            preset.id,
          );
          applied = ok ? "（已应用到当前会话）" : "（当前会话应用失败）";
        } else if (agent) {
          applied = "（当前会话已有内容，Preset 将应用于下一个新会话）";
        }
        const synced = saved ? "" : "⚠️ 无法写入 DSH 设置（仅本次进程内生效）";
        await this.sendReply(userId, `✅ 默认 Preset 已切换: ${preset.name ?? preset.id}${applied}${synced}。`);
        return;
      }
      case "status": {
        // `/preset` is the deployment-default family (`list` / `switch`
        // write the DSH settings document). Status must report that
        // default — not the bound session's live preset. `/status` and
        // `/s list` remain the session-live views. Agent status belongs
        // on `/status`, not here.
        const defaultId = this.ops.defaultPresetId();
        const defaultLabel = (await this.resolvePresetLabel(defaultId)) ?? "（未设置）";
        const lines = [`🤖 默认 Preset: ${defaultLabel}`];
        const liveId = user.sessionId
          ? await this.ops.resolveSessionPreset(user.sessionId)
          : undefined;
        if (liveId && liveId !== defaultId) {
          const liveLabel = (await this.resolvePresetLabel(liveId)) ?? liveId;
          lines.push(`当前会话: ${liveLabel}`);
        }
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
    }
  }

  // ─── Reasoning effort ───

  /**
   * `/reasoning` — view or switch the reasoning effort. The effort rides the
   * same model selection as the GUI's model picker: the current session's
   * override or logged config, with the deployment default underneath.
   * Switching persists via `agentDefaultModel.saveSelection` (same settings
   * document the GUI edits) and applies to the live agent through the
   * `agent/request` override.
   */
  private async handleReasoningCommand(userId: string, cmd: ReasoningCommand): Promise<void> {
    const user = this.state.ensureUser(userId, this.config.cwd);
    const agent = this.agents.get(user);
    const active = this.resolveEffectiveModel(user, agent);

    if (cmd.kind === "list" || cmd.kind === "switch" || cmd.kind === "clear") {
      if (!agent || !active?.provider || !active.model) {
        await this.sendReply(userId, "⚠️ 当前没有可用会话。先发一条消息或 /session new 创建会话。");
        return;
      }
    }

    // The current model's supported effort levels (adapter capability).
    const reasoning =
      active?.provider && active.model
        ? await this.ops.resolveModelReasoning(active.provider, active.model)
        : undefined;

    const effortName = (id: string): string => {
      const level = reasoning?.efforts.find((e) => e.id === id);
      return level?.name ?? id;
    };

    switch (cmd.kind) {
      case "list": {
        if (!reasoning || reasoning.efforts.length === 0) {
          await this.sendReply(userId, `🧠 当前模型（${active!.provider}/${active!.model}）不支持推理等级。`);
          return;
        }
        const current = active!.reasoningEffort;
        const lines = [`🧠 ${active!.provider}/${active!.model} 的推理等级（/reasoning switch <等级> 切换）`];
        reasoning.efforts.forEach((effort, i) => {
          const markers = [
            current === effort.id ? " ◀ 当前" : "",
            effort.id === reasoning.defaultEffort && current === undefined ? "（模型默认）" : "",
          ].join("");
          lines.push(`${i + 1}. ${effort.name} — ${effort.id}${markers}`);
          if (effort.description) lines.push(`   ${effort.description}`);
        });
        if (reasoning.defaultEffort) {
          lines.push(`默认: ${effortName(reasoning.defaultEffort)}`);
        }
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "status": {
        const defaultModel = this.ops.defaultModelSelection();
        const lines = ["🧠 推理等级"];
        if (agent && active?.provider && active.model) {
          const current = active.reasoningEffort;
          const label = current ? effortName(current) : "（模型默认）";
          const source = this.modelOverrides.has(agent.id) && current ? "（本会话设置）" : "";
          lines.push(`• 当前会话: ${active.provider}/${active.model} — ${label}${source}`);
        } else if (!agent) {
          lines.push("• 当前会话: （未绑定会话）");
        }
        if (defaultModel) {
          const label = defaultModel.reasoningEffort ? effortName(defaultModel.reasoningEffort) : "（模型默认）";
          lines.push(`• 默认: ${defaultModel.provider}/${defaultModel.model} — ${label}`);
        }
        if (reasoning && reasoning.efforts.length > 0) {
          lines.push(`• 可用: ${reasoning.efforts.map((e) => e.name).join(" / ")}`);
        } else if (active?.provider && active.model) {
          lines.push("• 当前模型不支持推理等级");
        }
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "switch": {
        if (!reasoning || reasoning.efforts.length === 0) {
          await this.sendReply(userId, `🧠 当前模型（${active!.provider}/${active!.model}）不支持推理等级。`);
          return;
        }
        const matched = reasoning.efforts.find((e) => e.id === cmd.target || e.name === cmd.target);
        if (!matched) {
          await this.sendReply(
            userId,
            `⚠️ 未知推理等级: ${cmd.target}。可用: ${reasoning.efforts.map((e) => `${e.name}（${e.id}）`).join(", ")}`,
          );
          return;
        }
        // Apply to the live agent (via agent/request) and as the new default.
        const selection = { provider: active!.provider!, model: active!.model!, reasoningEffort: matched.id };
        if (agent) {
          this.modelOverrides.set(agent.id, selection);
        }
        const saved = await this.ops.saveDefaultModel(selection);
        const lines = [`✅ 推理等级已切换: ${matched.name}（${matched.id}）`];
        if (agent) lines.push("（已应用到当前会话，下一步生效）");
        if (!saved) lines.push("⚠️ 无法更新默认（仅当前会话生效）");
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "clear": {
        // Restore the provider/model default: drop the effort from the
        // override and from the persisted default.
        if (agent) {
          const override = this.modelOverrides.get(agent.id);
          if (override) {
            const { reasoningEffort: _dropped, ...rest } = override;
            this.modelOverrides.set(agent.id, rest);
          }
        }
        const saved = await this.ops.saveDefaultModel({ provider: active!.provider!, model: active!.model! });
        const lines = ["✅ 推理等级已恢复为模型默认"];
        if (!saved) lines.push("⚠️ 无法更新默认（仅当前会话生效）");
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
    }
  }

  // ─── History ──────────────────────────────────────────────────────────────

  /**
   * `/history [N]` — show the most recent N conversation entries of the
   * current session (default 5, max 20). Each entry is rendered as
   * `序号 [时间] 角色: 文本摘要`, oldest→newest, with per-entry truncation
   * at 300 chars to stay within WeChat limits.
   */
  private async handleHistoryCommand(userId: string, cmd: HistoryCommand, user: UserState): Promise<void> {
    if (!user.sessionId) {
      await this.sendReply(userId, "💬 暂无会话，发送消息后可查看历史（/history [1-20]）");
      return;
    }
    const count = Math.max(1, Math.min(cmd.count, HISTORY_MAX));
    let entries: Array<{ role: "user" | "assistant"; text: string; time: number }>;
    try {
      entries = await this.ops.getSessionHistory(user.sessionId, count);
    } catch (err) {
      console.warn(`[dsh-wechat] getSessionHistory failed: ${String(err)}`);
      await this.sendReply(userId, `⚠️ 读取历史失败：${String(err)}`);
      return;
    }
    if (entries.length === 0) {
      await this.sendReply(userId, "📜 暂无历史消息。");
    } else {
      const HISTORY_TEXT_LIMIT = 800;
      // The most recent assistant reply is the one the reader is most
      // likely to want to read end-to-end — keep it untruncated so the
      // answer to "what did the model just say" doesn't cut off at 800
      // chars. Earlier entries still cap at HISTORY_TEXT_LIMIT; a long
      // assistant reply flows into the next WeChat chunk via splitText.
      let lastAssistantIdx = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]!.role === "assistant") {
          lastAssistantIdx = i;
          break;
        }
      }
      const lines: string[] = [`📜 最近 ${entries.length} 条历史${entries.length >= HISTORY_MAX && count >= HISTORY_MAX ? "（最多展示 20 条）" : ""}`];
      lines.push("");
      entries.forEach((e, i) => {
        const roleLabel = e.role === "user" ? "你" : "助手";
        const when = e.time ? this.formatRelativeTime(e.time) : "未知时间";
        const keepFull = i === lastAssistantIdx;
        const body = keepFull
          ? e.text
          : e.text.length > HISTORY_TEXT_LIMIT
            ? e.text.slice(0, HISTORY_TEXT_LIMIT - 1) + "…"
            : e.text;
        const compact = body.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
        lines.push(`${i + 1}. [${when}] ${roleLabel}: ${compact}`);
      });
      lines.push("", `提示: /history [1-${HISTORY_MAX}] 查看不同条数（默认 5）`);
      await this.sendReply(userId, lines.join("\n"));
    }
    await this.resendPendingCardsForHistory(userId);
  }

  /** After `/history`, re-send every still-pending card of the current session in full. */
  private async resendPendingCardsForHistory(userId: string): Promise<void> {
    const { approvals, questions } = this.pendingCardsForCurrentSession(userId);
    if (approvals.length === 0 && questions.length === 0) return;
    await this.sendReply(userId, "⏳ 当前会话有待处理卡片，完整内容如下（直接回复即可）：");
    for (const card of approvals) {
      await this.sendApprovalCard(userId, card, approvals.length);
    }
    for (const card of questions) {
      await this.sendQuestionCard(userId, card, card.items, questions.length);
    }
  }

  private async handleModelCommand(userId: string, cmd: ModelCommand): Promise<void> {
    const user = this.state.ensureUser(userId, this.config.cwd);
    switch (cmd.kind) {
      case "list": {
        const providers = this.ops.listProviders();
        if (providers.length === 0) {
          await this.sendReply(userId, "🧠 没有可用的模型提供商。");
          return;
        }
        if (cmd.provider) {
          const provider = providers.find((p) => p.id === cmd.provider || p.name === cmd.provider);
          if (!provider) {
            await this.sendReply(userId, `⚠️ 未知提供商: ${cmd.provider}。可用: ${providers.map((p) => p.id).join(", ")}`);
            return;
          }
          const models = await this.ops.listModels(provider.id);
          const lines = [`🧠 ${provider.id} 的模型（/model switch ${provider.id}/<模型id> 切换）`];
          models.forEach((model, i) => {
            lines.push(`${i + 1}. ${model.id}${model.description ? `（${model.description}）` : ""}`);
          });
          await this.sendReply(userId, lines.join("\n"));
          return;
        }
        const lines = ["🧠 模型提供商（/model list <提供商id> 查看模型）"];
        providers.forEach((p, i) => lines.push(`${i + 1}. ${p.id}`));
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "switch": {
        const [provider, model] = cmd.target.split("/");
        const providers = this.ops.listProviders();
        const matchedProvider = providers.find((p) => p.id === provider || p.name === provider);
        if (!matchedProvider) {
          await this.sendReply(userId, `⚠️ 未知提供商: ${provider}。可用: ${providers.map((p) => p.id).join(", ")}`);
          return;
        }
        const models = await this.ops.listModels(matchedProvider.id);
        const matchedModel = models.find((m) => m.id === model || m.name === model);
        if (!matchedModel) {
          await this.sendReply(userId, `⚠️ 未知模型: ${model}。用 /model list ${matchedProvider.id} 查看可用模型。`);
          return;
        }
        // Apply to the live agent (via agent/request) and as the new default.
        const agent = this.agents.get(user);
        // Preserve the user's current reasoning effort across the model
        // switch — the override carries the per-session effort set by
        // `/reasoning switch`, and the persisted default may carry a
        // GUI-set effort. Pick the more local of the two and keep it on
        // the new model only when the new model actually supports that
        // effort id; otherwise drop it so the LLM call never sees an
        // unsupported value. The contract documented on
        // `applyModelOverride` — "`/model switch` does not clear a set
        // effort" — finally holds for the override AND the persisted
        // default, so `/status` (which reads the override via
        // `resolveEffectiveModel`) keeps showing the effort.
        const existingEffort =
          (agent ? this.modelOverrides.get(agent.id)?.reasoningEffort : undefined) ??
          this.ops.defaultModelSelection()?.reasoningEffort;
        let preservedEffort: string | undefined;
        let preservedLabel: string | undefined;
        if (existingEffort !== undefined) {
          const newReasoning = await this.ops.resolveModelReasoning(matchedProvider.id, matchedModel.id);
          const supported = newReasoning?.efforts.find((e) => e.id === existingEffort);
          if (supported) {
            preservedEffort = existingEffort;
            preservedLabel = supported.name;
          }
        }
        const selection: ModelSelection =
          preservedEffort !== undefined
            ? { provider: matchedProvider.id, model: matchedModel.id, reasoningEffort: preservedEffort }
            : { provider: matchedProvider.id, model: matchedModel.id };
        if (agent) {
          this.modelOverrides.set(agent.id, selection);
        }
        const saved = await this.ops.saveDefaultModel(selection);
        const lines = [`✅ 已切换到模型: ${matchedProvider.id}/${matchedModel.id}`];
        if (agent) lines.push("（已应用到当前会话，下一步生效）");
        if (preservedLabel) {
          lines.push(`（推理等级 ${preservedLabel} 保留，用 /reasoning 调整）`);
        }
        if (!saved) lines.push("⚠️ 无法更新默认模型（仅当前会话生效）");
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "status": {
        const agent = this.agents.get(user);
        const active = this.resolveEffectiveModel(user, agent);
        const defaultModel = this.ops.defaultModelSelection();
        const lines = ["🧠 模型状态"];
        if (agent && active?.provider && active?.model) {
          lines.push(`• 当前会话: ${active.provider}/${active.model}`);
        }
        if (defaultModel) {
          lines.push(`• 默认: ${defaultModel.provider}/${defaultModel.model}`);
        }
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
    }
  }

  // ─── Permission presets ───

  /**
   * `/perm` — permission management over the native permissionPresets
   * service (session-level switches) and the `permission` settings document
   * (the default for new sessions, shared with the GUI settings page).
   */
  private async handlePermCommand(userId: string, cmd: PermCommand): Promise<void> {
    const user = this.state.ensureUser(userId, this.config.cwd);
    const service = this.ops.permissionPresets();
    if (!service) {
      await this.sendReply(userId, "⚠️ 当前部署未启用权限预设（permissionPresets 服务不可用）。");
      return;
    }

    const agent = this.agents.get(user);
    const current = agent ? this.safeCurrent(service, agent) : undefined;

    switch (cmd.kind) {
      case "list": {
        const lines = ["🔐 可用权限预设（/perm switch <名称|编号> 切换当前会话）"];
        service.names.forEach((name, i) => {
          const option = service.optionOf(name);
          const markers = [
            current === name ? " ◀ 当前会话" : "",
            name === service.defaultPreset ? "（默认）" : "",
          ].join("");
          lines.push(`${i + 1}. ${option.name} — ${name}${markers}`);
          if (option.description) lines.push(`   ${option.description}`);
        });
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "status": {
        const defaultName = service.defaultPreset;
        const lines = ["🔐 权限状态"];
        if (agent && current) {
          lines.push(`• 当前会话: ${this.describePermission(service, current)}`);
        } else if (!agent) {
          lines.push("• 当前会话: （未绑定会话）");
        }
        lines.push(`• 新会话默认: ${this.describePermission(service, defaultName)}`);
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "switch": {
        if (!agent) {
          await this.sendReply(userId, "⚠️ 当前没有会话。先发一条消息或 /session new 创建会话，再切换权限。");
          return;
        }
        const name = this.matchPermission(service, cmd.target);
        if (!name) {
          await this.sendReply(userId, `⚠️ 未知权限预设: ${cmd.target}。可用: ${service.names.join(", ")}`);
          return;
        }
        try {
          service.set(agent.session, name);
        } catch (err) {
          await this.sendReply(userId, `⚠️ 切换权限失败: ${String(err)}`);
          return;
        }
        const lines = [`✅ 当前会话权限已切换: ${this.describePermission(service, name)}`];
        if (name === "danger-full-access") {
          lines.push("⚠️ 完整访问权限：不再有审批提示，请谨慎使用。");
        }
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "default": {
        if (!cmd.target) {
          await this.sendReply(userId, `🔐 新会话默认权限: ${this.describePermission(service, service.defaultPreset)}`);
          return;
        }
        const name = this.matchPermission(service, cmd.target);
        if (!name) {
          await this.sendReply(userId, `⚠️ 未知权限预设: ${cmd.target}。可用: ${service.names.join(", ")}`);
          return;
        }
        const saved = await this.ops.saveDefaultPermission(name);
        const lines = [`✅ 新会话默认权限已设为: ${this.describePermission(service, name)}`];
        if (saved) {
          lines.push("（已写入 DSH 设置，与 GUI 设置页同步，新会话生效）");
        } else {
          lines.push("⚠️ 无法写入 DSH 设置（仅本次进程内生效）");
        }
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
    }
  }

  /** `current()` with a guard: session events may be absent on some shapes. */
  private safeCurrent(
    service: { current(events: readonly { type: string; data?: unknown }[]): string },
    agent: Agent,
  ): string | undefined {
    try {
      const events = agent.session?.events ?? [];
      return service.current(events);
    } catch {
      return undefined;
    }
  }

  /** Resolve a preset target by name or list index. */
  private matchPermission(
    service: { readonly names: readonly string[] },
    target: string,
  ): string | undefined {
    if (/^\d+$/.test(target)) {
      const index = parseInt(target, 10);
      return service.names[index - 1];
    }
    return service.names.find((n) => n === target);
  }

  /** Human-readable preset description: name（sandbox + approval）plus detail. */
  private describePermission(
    service: {
      resolve(name: string): { sandbox: string; approval: string; name?: string; description?: string };
      optionOf(name: string): { value: string; name: string; description?: string };
    },
    name: string,
  ): string {
    try {
      const spec = service.resolve(name);
      const label = spec.name ?? name;
      const detail = spec.description ? `（${spec.description}）` : "";
      return `${label}（${spec.sandbox} + ${spec.approval}）${detail}`;
    } catch {
      const option = service.optionOf(name);
      return `${option.name}（${option.description ?? ""}）`.replace(/（\s*）$/, "");
    }
  }

  /**
   * Apply the user's model override to a frozen request config. Called from
   * the `agent/request` waterfall listener (registered in index.ts) for
   * WeChat-bound agents. An override without a reasoning effort leaves the
   * caller's effort untouched (`/model switch` does not clear a set effort).
   *
   * The override itself is preserved by `handleModelCommand` when the user
   * issues `/model switch`: the new selection carries the existing effort
   * (from the override first, then the persisted default) IF the new
   * model supports the same effort id. So in practice this merge is the
   * last-line defense for the live request; the displayed selection (in
   * `/status` via `resolveEffectiveModel`) reads the effort straight off
   * the override.
   */
  applyModelOverride(
    config: { provider: string; model: string; reasoningEffort?: string },
    agentId: string,
  ): { provider: string; model: string; reasoningEffort?: string } {
    const override = this.modelOverrides.get(agentId);
    if (!override) return config;
    return {
      ...config,
      provider: override.provider,
      model: override.model,
      ...(override.reasoningEffort !== undefined ? { reasoningEffort: override.reasoningEffort } : {}),
    };
  }

  /**
   * Color marker for boolean toggles on /status. Each field has its own
   * semantic — `on` for 静默模式 means "we stop forwarding to WeChat"
   * (warning), `on` for 跨会话通知 means "extra delivery is enabled"
   * (good). The colored glyph is field-specific; this helper just
   * annotates an explicit `value` with `🟢` / `🔴`. iLink text items
   * have no `<font color>` support — emoji glyphs are the only
   * colored channel that survives the wire.
   */
  private paintBadge(value: string, polarity: "positive" | "warning" | "neutral"): string {
    if (polarity === "positive") return `🟢 ${value}`;
    if (polarity === "warning") return `🔴 ${value}`;
    return `⚪ ${value}`;
  }

  private async formatStatus(user: UserState): Promise<string> {
    const agent = this.agents.get(user);

    // 会话标题（sessionQuery 投影），无标题时退回 id 前 12 位。
    const sessionLabel = user.sessionId
      ? (await this.ops.readSessionTitle(user.sessionId)) ?? user.sessionId.slice(0, 12)
      : "（未绑定）";

    // 实际生效的模型：本会话 override（/model switch）> 会话最近请求记录 >
    // agent 创建选项 > 部署默认模型。与 GUI 的 selectionFor 同款优先级。
    const active = this.resolveEffectiveModel(user, agent);

    // 当前会话的权限预设（native permissionPresets 折叠），服务缺失时省略。
    const permissionService = this.ops.permissionPresets();
    const permission = agent && permissionService ? this.safeCurrent(permissionService, agent) : undefined;

    // 上下文占用（token-meter 的 contextPressure 投影，与 GUI 上下文计量同源）：
    // 已用 = 下一个请求的预计 prompt 占用，总 = 模型上下文窗口。
    const pressure = agent ? this.ops.contextPressure(agent.session) : undefined;
    let contextLabel: string | undefined;
    if (pressure?.projectedTokens !== undefined && pressure.contextWindow !== undefined) {
      contextLabel = `• 上下文: ${formatTokens(pressure.projectedTokens)} / ${formatTokens(pressure.contextWindow)}（${Math.round((pressure.projectedTokens / pressure.contextWindow) * 100)}%）`;
    } else if (pressure?.projectedTokens !== undefined) {
      contextLabel = `• 上下文: ${formatTokens(pressure.projectedTokens)}（总量未知）`;
    }

    // 推理等级名称（当前模型能力），模型行附注用。
    let effortSuffix = "";
    if (active?.provider && active.model && active.reasoningEffort) {
      const reasoning = await this.ops.resolveModelReasoning(active.provider, active.model);
      const level = reasoning?.efforts.find((e) => e.id === active.reasoningEffort);
      effortSuffix = `（推理: ${level?.name ?? active.reasoningEffort}）`;
    }

    const crossEffective = this.shouldNotifyCrossSession(user.userId) ? "on" : "off";
    const presetLines = await this.formatStatusPresetLines(user);
    const pendingLine = this.formatPendingStatusLine(user.userId);
    const agentLabel = agent
      ? agent.status === "running"
        ? this.paintBadge("running", "positive")
        : this.paintBadge("idle", "neutral")
      : this.paintBadge("（未加载）", "warning");
    const lines = [
      "📊 当前状态",
      `• 工作区: ${user.cwd}`,
      `• 会话: ${sessionLabel}`,
      `• Agent: ${agentLabel}`,
      ...(pendingLine ? [pendingLine] : []),
      presetLines.sessionLine,
      `• 模型: ${active?.provider && active?.model ? `${active.provider}/${active.model}${effortSuffix}` : "（默认）"}`,
      ...(contextLabel ? [contextLabel] : []),
      ...(permission
        ? [`• 权限: ${permission.startsWith("danger") ? this.paintBadge(permission, "warning") : permission}`]
        : []),
      presetLines.defaultLine,
      // 静默模式 on = we stop forwarding (warning); off = normal delivery (good).
      `• 静默模式: ${this.paintBadge(user.silent ? "on" : "off", user.silent ? "warning" : "positive")}`,
      `• 繁忙投递: ${this.ops.busyEnter() === "steer" ? this.paintBadge("steer（插话）", "positive") : this.paintBadge("queue（排队）", "neutral")}`,
      // 跨会话通知 on = extra notifications enabled (good); off = quiet (also fine, neutral).
      `• 跨会话通知: ${this.paintBadge(crossEffective, crossEffective === "on" ? "positive" : "neutral")}`,
    ];

    // Session-level projection registry (`ctx.sessionProjections`). One
    // Session-level state published by every DSH plugin via
    // `ctx.sessionProjections` — plan mode, goal, token usage, image
    // limits, etc. The aggregator (`renderProjectionSection`) groups
    // known keys by intent (mode / usage / session / other), renders
    // each known key with a purpose-built smart formatter, and falls
    // back to JSON for unknown keys — DSH adds new plugins → WeChat
    // lights up new rows under `[其它]` with zero bridge change.
    if (agent && agent.session) {
      const proj = this.ops.sessionProjections();
      if (proj) {
        try {
          // The bridge's structural `Agent.session` only declares the
          // fields it touches; `seq` (the snapshot watermark index) is
          // host-side. Duck-typed cast: dsh-session's concrete `Session`
          // is structurally compatible with `AgentSessionLike` at
          // runtime.
          const { values } = proj.snapshot(agent.session as never);
          const sectionLines = renderProjectionSection(values);
          if (sectionLines.length > 0) {
            lines.push("", "── 会话级状态 ──", ...sectionLines);
          }
        } catch (err) {
          console.warn(`[dsh-wechat] sessionProjections.snapshot failed: ${String(err)}`);
        }
      }
    }

    return lines.join("\n");
  }

  /** `/status` row for unanswered cards of the current session; omitted when none. */
  private formatPendingStatusLine(userId: string): string | undefined {
    const { approvals, questions } = this.pendingCardsForCurrentSession(userId);
    const parts: string[] = [];
    if (questions.length > 0) parts.push(`${questions.length} 张提问卡`);
    if (approvals.length > 0) parts.push(`${approvals.length} 张权限卡`);
    if (parts.length === 0) return undefined;
    // Red marker — reader's eye should jump to "needs answer" rows.
    return `🔴 • 待处理: ${parts.join(" · ")}`;
  }

  /**
   * `/status` preset rows: deployment default (settings document) and
   * the bound session's live preset (event-aware). Shown as two lines
   * so a switched session is not mistaken for the global default.
   * The default row sits after permission; the session row stays with
   * the session/agent block.
   */
  private async formatStatusPresetLines(user: UserState): Promise<{
    defaultLine: string;
    sessionLine: string;
  }> {
    const defaultId = this.ops.defaultPresetId();
    const defaultLabel = (await this.resolvePresetLabel(defaultId)) ?? "（未设置）";
    const defaultLine = `• 默认 Preset: ${defaultLabel}`;
    if (!user.sessionId) {
      return { defaultLine, sessionLine: "• 当前会话 Preset: （未绑定）" };
    }
    const liveId = await this.ops.resolveSessionPreset(user.sessionId);
    const liveLabel = liveId
      ? ((await this.resolvePresetLabel(liveId)) ?? liveId)
      : "（无记录）";
    return { defaultLine, sessionLine: `• 当前会话 Preset: ${liveLabel}` };
  }

  /**
   * Preset id → metadata display name (`/preset list` 同款 `preset.name ?? preset.id`).
   * Used everywhere the bridge shows a preset (session list, /status, /preset status default),
   * so a session actually running `cordis` shows up as "创造模式" rather than the
   * raw id. Returns undefined when the id is missing; returns the id itself when
   * the roster has no matching entry or no `name` field — both edges preserve
   * `/preset list`'s fallback semantics so a deleted/broken preset never produces
   * an empty label.
   */
  private async resolvePresetLabel(presetId: string | undefined): Promise<string | undefined> {
    if (!presetId) return undefined;
    const presets = await this.ops.listPresets();
    const hit = presets.find((p) => p.id === presetId);
    return hit?.name ?? presetId;
  }

  /**
   * Recency value for `/s list` ordering and display: the last recorded
   * user-prompt time, falling back to the session creation time for cold
   * sessions (no activity observed since this process started).
   */
  private sessionActivityTime(record: { header: { id: string; createdAt: number } }): number {
    return this.lastActivityBySession.get(record.header.id) ?? record.header.createdAt;
  }

  /** Compact relative time for the `/s list` column (like the GUI sidebar). */
  private formatRelativeTime(t: number): string {
    const diff = Date.now() - t;
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }

  /**
   * The model the user's session actually runs on: this session's override
   * (`/model switch`) > the session's latest logged request config > the
   * agent's creation options > the deployment default model. Same precedence
   * as the GUI's `selectionFor`.
   *
   * `reasoningEffort` follows the same precedence chain, with one defensive
   * branch: when the override carries a model selection but no effort AND
   * the persisted default has an effort for the SAME model, borrow that
   * effort. This rescues users whose override was written by an older
   * `/model switch` that did not preserve the effort — they see the
   * preserved effort in `/status` immediately on upgrade instead of
   * needing to re-issue `/reasoning switch`. Only triggers when the
   * default's provider/model matches the override; otherwise the default's
   * effort belongs to a different model and must not be applied.
   */
  private resolveEffectiveModel(
    user: UserState,
    agent: Agent | undefined,
  ): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
    const override = agent ? this.modelOverrides.get(agent.id) : undefined;
    if (override) {
      if (override.reasoningEffort === undefined) {
        const def = this.ops.defaultModelSelection();
        if (
          def &&
          def.provider === override.provider &&
          def.model === override.model &&
          def.reasoningEffort !== undefined
        ) {
          return { ...override, reasoningEffort: def.reasoningEffort };
        }
      }
      return override;
    }
    const logged = agent?.session?.requestHeader?.()?.config;
    if (logged?.provider && logged.model) return logged;
    if (agent?.options?.provider && agent.options.model) return agent.options;
    return this.ops.defaultModelSelection();
  }

  // ─── send-wechat tool ───

  /**
   * Handle the `send_wechat` tool: push text or a local file to a
   * WeChat user. The recipient is the user bound to the calling agent
   * (session), or — when the agent has no binding — the first known
   * WeChat user (single-user deployments are the norm).
   *
   * Delivery goes through `deliverOutbound`, so tool pushes share the same
   * per-user gateway budget as assistant replies, and budget overflow /
   * transient send failures are queued (`/next` or the next inbound
   * message flushes them) instead of being lost. A queued push reports
   * `ok: true` with an explicit "queued" message: the bridge has taken
   * over delivery, and an error result would only tempt the model into
   * retrying (→ duplicate deliveries on flush). Only an unreadable
   * `file_path` returns `ok: false` immediately.
   */
  async handleSendWeChat(agentId: string, args: { text?: string; file_path?: string }): Promise<{ ok: boolean; message: string }> {
    const user = this.resolveUserForAgent(agentId);
    if (!user) {
      return { ok: false, message: "no WeChat user has interacted yet; a WeChat message must arrive before send_wechat can be used" };
    }
    if (!this.token) {
      return { ok: false, message: "WeChat is not logged in" };
    }
    if (this.tokenGiveUp) {
      return { ok: false, message: "WeChat bot token is invalid; re-scan the QR code" };
    }

    if (args.file_path) {
      const filePath = args.file_path;
      const fileName = filePath.split(/[\\/]/).pop() ?? "file";
      // Send images/videos with their native media type so WeChat renders
      // them inline; everything else goes as a file attachment.
      const mediaType = mediaTypeForFile(fileName);
      const kind = mediaType === UploadMediaType.IMAGE ? "image" : mediaType === UploadMediaType.VIDEO ? "video" : "file";
      const outcome = await this.deliverOutbound(user.userId, { kind: "file", filePath, fileName });
      if (outcome === "failed") {
        if (this.tokenGiveUp) {
          return { ok: false, message: "WeChat bot token is invalid; re-scan the QR code" };
        }
        return { ok: false, message: `file not found: ${filePath}` };
      }
      return outcome === "sent"
        ? { ok: true, message: `sent ${kind} ${fileName}` }
        : { ok: true, message: this.tokenInvalid
          ? `queued ${kind} ${fileName}; WeChat session timed out, will send after recover`
          : `queued ${kind} ${fileName}; delivery deferred by WeChat rate limiting, the user can flush with /next` };
    }
    if (args.text) {
      const segments = splitText(args.text, this.config.textChunkLimit);
      let sent = 0;
      let queued = 0;
      for (const segment of segments) {
        const outcome = await this.deliverOutbound(user.userId, { kind: "text", text: segment });
        if (outcome === "sent") {
          sent++;
        } else if (outcome === "cached") {
          queued++;
        } else {
          return { ok: false, message: this.tokenGiveUp ? "WeChat bot token is invalid; re-scan the QR code" : "failed to send WeChat message" };
        }
      }
      return queued === 0
        ? { ok: true, message: `sent ${sent} message(s)` }
        : { ok: true, message: this.tokenInvalid
          ? `sent ${sent} message(s), queued ${queued} (session timeout; will send after recover)`
          : `sent ${sent} message(s), queued ${queued} (WeChat rate limiting); the user can flush with /next` };
    }
    return { ok: false, message: "provide either text or file_path" };
  }

  // ─── Outbound sending (WeChat gateway limits) ───
  //
  // Assistant replies and send_wechat tool pushes share ONE window budget
  // and ONE FIFO queue because this bridge intentionally serves one peer.

  /** Deliver one item, serialized with all other outbound sends and flushes. */
  private deliverOutbound(userId: string, item: CachedMessage): Promise<"sent" | "cached" | "failed"> {
    return this.serializeOutbound(() => this.deliverOutboundLocked(userId, item));
  }

  private async deliverOutboundLocked(userId: string, item: CachedMessage): Promise<"sent" | "cached" | "failed"> {
    const token = this.token;
    if (!token || this.tokenGiveUp) {
      this.logDropOutbound(item.kind === "text" ? item.text.slice(0, 60) : item.fileName);
      return "failed";
    }
    if (this.tokenInvalid) {
      this.logDropOutbound(item.kind === "text" ? item.text.slice(0, 60) : item.fileName);
      this.parkOutbound(userId, item);
      return "cached";
    }

    // Validate file paths before consuming budget or poisoning the durable queue.
    let buffer: Buffer | undefined;
    if (item.kind === "file") {
      try {
        buffer = await fs.promises.readFile(item.filePath);
      } catch (err) {
        this.log(`outbound file read failed (${item.filePath}): ${String(err)}`);
        return "failed";
      }
    }

    const count = this.wechatMsgCount;
    if (count >= MSG_LIMIT_MAX) {
      this.parkOutbound(userId, item);
      // No notice here: an 11th direct send would hit the same closed window.
      return "cached";
    }

    // Persist the conservative reservation before crossing the remote-send boundary.
    this.wechatMsgCount = count + 1;
    this.persistOutboundState(userId);
    const contextToken = this.wireContextToken ?? undefined;
    try {
      if (item.kind === "text") {
        const payload = count + 1 > MSG_LIMIT_WARN
          ? item.text + `\n\n⚠️ 微信限制连续发送消息数量10条（已发 ${count + 1} 条），发送 /next 可继续`
          : item.text;
        await sendTextMessage(userId, payload, {
          baseUrl: token.baseUrl,
          token: token.token,
          contextToken,
        });
      } else {
        await sendMediaMessage(userId, mediaTypeForFile(item.fileName), buffer!, {
          baseUrl: token.baseUrl,
          token: token.token,
          contextToken,
          cdnBaseUrl: this.config.cdnBaseUrl,
          fileName: item.fileName,
        });
      }
      return "sent";
    } catch (err) {
      this.log(`outbound send error (${item.kind}): ${String(err)}`);
      if (isMessageLimitError(err)) {
        this.wechatMsgCount = MSG_LIMIT_MAX;
        this.parkOutbound(userId, item);
        return "cached";
      }
      if (isSessionTimeoutError(err)) {
        this.markTokenInvalid();
        this.logDropOutbound(item.kind === "text" ? item.text.slice(0, 60) : item.fileName);
        this.parkOutbound(userId, item);
        return "cached";
      }
      // Logout/re-login may abort an in-flight send. Never carry that text
      // across identities; every other delivery error is parked.
      if (!this.token || this.tokenGiveUp) {
        this.logDropOutbound(item.kind === "text" ? item.text.slice(0, 60) : item.fileName);
        return "failed";
      }
      this.parkOutbound(userId, item);
      await this.notifyCachePendingLocked(userId);
      return "cached";
    }
  }

  /** Append to the one durable FIFO, dropping oldest items above the hard cap. */
  private parkOutbound(userId: string, item: CachedMessage): void {
    this.outboundCache.push({ ...item });
    if (this.outboundCache.length > MAX_OUTBOUND_QUEUE) {
      const overflow = this.outboundCache.length - MAX_OUTBOUND_QUEUE;
      this.outboundCache.splice(0, overflow);
      this.log(`outbound cache cap (${MAX_OUTBOUND_QUEUE}) exceeded; dropped ${overflow} oldest item(s)`);
    }
    this.persistOutboundState(userId);
  }

  /** Best-effort notice for transient failures while budget remains. */
  private async notifyCachePendingLocked(userId: string): Promise<void> {
    if (this.cacheNoticeSent || this.wechatMsgCount >= MSG_LIMIT_MAX) return;
    const token = this.token;
    if (!token || this.tokenInvalid || this.outboundCache.length === 0) return;
    this.cacheNoticeSent = true;
    this.wechatMsgCount++;
    this.persistOutboundState(userId);
    const notice = `💾 有 ${this.outboundCache.length} 条消息暂存待发（微信限流或发送失败），发送 /next 可继续发送。`;
    try {
      await sendTextMessage(userId, notice, {
        baseUrl: token.baseUrl,
        token: token.token,
        ...(this.wireContextToken ? { contextToken: this.wireContextToken } : {}),
      });
    } catch (err) {
      this.cacheNoticeSent = false;
      if (isMessageLimitError(err)) this.wechatMsgCount = MSG_LIMIT_MAX;
      if (isSessionTimeoutError(err)) this.markTokenInvalid();
      this.persistOutboundState(userId);
    }
  }

  private async sendReply(userId: string, text: string): Promise<void> {
    if (!this.token || this.tokenGiveUp) {
      this.logDropOutbound(text.slice(0, 60));
      return;
    }
    const formatted = formatForWeChat(text);
    const segments = splitText(formatted, this.config.textChunkLimit);
    if (this.tokenInvalid) {
      this.logDropOutbound(text.slice(0, 60));
      await this.serializeOutbound(async () => {
        for (const segment of segments) this.parkOutbound(userId, { kind: "text", text: segment });
      });
      return;
    }
    for (const segment of segments) {
      await this.deliverOutbound(userId, { kind: "text", text: segment });
    }
  }

  /** After -14 recovery, silently flush the one peer's parked outbound. */
  private async flushParkedAfterRecover(): Promise<void> {
    const userId = this.peerUserId ?? this.state.all()[0]?.userId;
    if (!userId || this.outboundCache.length === 0) {
      this.log("-14 recovered; no parked outbound to flush");
      return;
    }
    this.log(`-14 recovered; flushing ${this.outboundCache.length} parked item(s) for ${userId}`);
    await this.flushPending(userId, { silent: true });
  }

  /** Flush the one FIFO (/next, next inbound, or -14 recovery). */
  private flushPending(userId: string, opts?: { silent?: boolean }): Promise<void> {
    return this.serializeOutbound(() => this.flushPendingLocked(userId, opts));
  }

  private async flushPendingLocked(userId: string, opts?: { silent?: boolean }): Promise<void> {
    if (this.outboundCache.length === 0) {
      if (!opts?.silent) await this.deliverOutboundLocked(userId, { kind: "text", text: "✅ 没有缓存的消息。" });
      return;
    }

    const cache = this.outboundCache.map((item) => ({ ...item }));
    // Keep the durable queue equal to the unsent tail throughout flush.
    // This favors at-least-once delivery at the unavoidable remote-send /
    // local-checkpoint crash boundary instead of losing queued messages.
    this.outboundCache = cache.map((item) => ({ ...item }));
    this.cacheNoticeSent = false;
    this.persistOutboundState(userId);
    let dropped = 0;
    let sentCount = 0;

    for (let index = 0; index < cache.length; index++) {
      const msg = cache[index]!;
      if (!this.token || this.tokenGiveUp || this.tokenInvalid || this.wechatMsgCount >= MSG_LIMIT_MAX) break;
      const token = this.token;
      this.wechatMsgCount++;
      this.persistOutboundState(userId);
      try {
        if (msg.kind === "text") {
          await sendTextMessage(userId, msg.text, {
            baseUrl: token.baseUrl,
            token: token.token,
            contextToken: this.wireContextToken ?? undefined,
          });
        } else {
          let buffer: Buffer;
          try {
            buffer = await fs.promises.readFile(msg.filePath);
          } catch (err) {
            this.log(`flush dropping unreadable cached file ${msg.filePath}: ${String(err)}`);
            dropped++;
            this.outboundCache.shift();
            this.persistOutboundState(userId);
            continue;
          }
          await sendMediaMessage(userId, mediaTypeForFile(msg.fileName), buffer, {
            baseUrl: token.baseUrl,
            token: token.token,
            contextToken: this.wireContextToken ?? undefined,
            cdnBaseUrl: this.config.cdnBaseUrl,
            fileName: msg.fileName,
          });
        }
        sentCount++;
        this.outboundCache.shift();
        this.persistOutboundState(userId);
      } catch (err) {
        this.log(`flush send error: ${String(err)}`);
        if (isMessageLimitError(err)) this.wechatMsgCount = MSG_LIMIT_MAX;
        if (isSessionTimeoutError(err)) this.markTokenInvalid();
        break;
      }
    }

    const remaining = this.outboundCache;
    this.persistOutboundState(userId);
    const dropSuffix = dropped > 0 ? `，${dropped} 条文件缓存因无法读取被丢弃` : "";
    if (remaining.length > 0) {
      this.log(`flush leftover ${remaining.length} item(s) for ${userId} (sent ${sentCount})`);
      if (!opts?.silent && this.wechatMsgCount < MSG_LIMIT_MAX) {
        await this.deliverOutboundLocked(userId, { kind: "text", text: `✅ 已发送 ${sentCount} 条，剩余 ${remaining.length} 条缓存，/next 继续。${dropSuffix}` });
      }
    } else {
      this.log(`flush completed ${sentCount} item(s) for ${userId}${dropSuffix}`);
      if (!opts?.silent && this.wechatMsgCount < MSG_LIMIT_MAX) {
        await this.deliverOutboundLocked(userId, { kind: "text", text: `✅ 全部 ${sentCount} 条缓存消息已发送${dropSuffix}。` });
      }
    }
  }


  private log(msg: string): void {
    console.log(`[dsh-wechat] ${msg}`);
  }

  private previewMessage(msg: WeixinMessage): string {
    const text = extractText(msg.item_list);
    if (text) {
      return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
    const types = (msg.item_list ?? []).map((i) => i.type).join(",");
    return `[media types: ${types || "none"}]`;
  }
}

/**
 * Clean a session title for WeChat display: strip legacy per-message hint
 * blocks (pre-fix sessions), collapse newlines/whitespace, and truncate.
 */
function cleanSessionTitle(title: string): string {
  return title
    .replace(/\[系统提示:[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28);
}

/**
 * Pick the WeChat upload media type for a file name: images and videos use
 * their native types so the WeChat client renders them inline instead of as
 * a file attachment that must be opened. Everything else stays a file.
 */
function mediaTypeForFile(fileName: string): 1 | 2 | 3 | 4 {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "svg"].includes(ext)) {
    return UploadMediaType.IMAGE;
  }
  if (["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v"].includes(ext)) {
    return UploadMediaType.VIDEO;
  }
  return UploadMediaType.FILE;
}

/** Compact token formatting: 128000 → "128k", 3500 → "3.5k", 900 → "900". */
function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(n);
}
