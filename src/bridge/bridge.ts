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
import { startMonitor } from "../weixin/monitor.js";
import { sendTextMessage, sendMediaMessage, splitText } from "../weixin/send.js";
import { sendTyping as apiSendTyping, getConfig as apiGetConfig } from "../weixin/api.js";
import { MessageType, TypingStatus, UploadMediaType } from "../weixin/types.js";
import type { WeixinMessage } from "../weixin/types.js";
import { extractText, weixinMessageToPrompt } from "../adapter/inbound.js";
import { formatForWeChat } from "../adapter/outbound.js";
import { formatQuestionForWeChat, parseQuestionReply, buildAnswer } from "../adapter/question-format.js";
import { formatApprovalCard, parseApprovalReply } from "../adapter/approval-format.js";
import { AgentStore, type BridgeContext } from "../dsh/sessions.js";
import { DshOps } from "../dsh/ops.js";
import type { Agent, AskUserQuestionAnswer, AskUserQuestionItem } from "../dsh/types.js";
import { StateStore, type UserState } from "../state.js";
import type { WeChatDSHConfig } from "../config.js";
import {
  detectUnknownSlashCommand,
  formatHelp,
  parseCompactCommand,
  parseHelpCommand,
  parseModelCommand,
  parseNextCommand,
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
  type CompactCommand,
  type ModelCommand,
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

type CachedMessage = { kind: "text"; text: string } | { kind: "file"; filePath: string; fileName: string };

export class WeChatDSHBridge {
  private readonly ctx: BridgeContext;
  private config: WeChatDSHConfig;
  private readonly state: StateStore;
  private readonly agents: AgentStore;
  private readonly ops: DshOps;

  private token: TokenData | null = null;
  /** Per-run monitor cancellation; recreated on every reconnect. */
  private monitorAbort: AbortController | null = null;
  private monitorRunning = false;
  private loginState: LoginState = { phase: "idle" };

  /** Last inbound context token per WeChat user (required to send). */
  private readonly contextTokens = new Map<string, string>();
  /** Pending question cards per user (rpcId-keyed, first = active). */
  private readonly pendingQuestions = new Map<string, PendingQuestion[]>();
  /** Pending approval cards per user (rpcId-keyed). */
  private readonly pendingApprovals = new Map<string, PendingApproval[]>();
  private readonly silentBuffers = new Map<string, string[]>();
  private readonly outboundCache = new Map<string, CachedMessage[]>();
  private readonly wechatMsgCount = new Map<string, number>();
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
  private muxAbort: AbortController | null = null;
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

  constructor(ctx: BridgeContext, config: WeChatDSHConfig) {
    this.ctx = ctx;
    this.config = config;
    this.state = new StateStore(config.storageDir);
    this.agents = new AgentStore(ctx);
    this.ops = new DshOps(ctx);
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
    for (const key of ["baseUrl", "cdnBaseUrl", "botType", "cwd", "textChunkLimit", "cardTimeoutMs"] as const) {
      editable[key] = this.config[key];
    }
    return {
      ...this.loginState,
      monitorRunning: this.monitorRunning,
      userCount: this.state.all().length,
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
  private async getTypingTicket(userId: string, contextToken: string): Promise<string | undefined> {
    const cached = this.typingTickets.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;
    if (!this.token) return undefined;
    try {
      const resp = await apiGetConfig({
        baseUrl: this.token.baseUrl,
        token: this.token.token,
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
    if (!this.token) return;
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) return;
    const ticket = await this.getTypingTicket(userId, contextToken);
    if (!ticket) return;
    try {
      await apiSendTyping({
        baseUrl: this.token.baseUrl,
        token: this.token.token,
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
   * is active. `reason` is recorded in the bridge log only.
   */
  private endTyping(userId: string, reason: string): void {
    const active = this.typingActive.get(userId);
    if (!active) return;
    clearInterval(active.keepAliveTimer);
    clearTimeout(active.safetyTimer);
    this.typingActive.delete(userId);
    void this.sendTypingStatus(userId, TypingStatus.CANCEL);
    this.log(`typing ended for ${userId} (${reason})`);
  }

  /** Start the bridge: resume with a stored token or begin QR login. */
  async start(): Promise<void> {
    this.token = loadToken(this.config.storageDir);
    if (this.token) {
      this.loginState = { phase: "logged-in", botId: this.token.accountId };
      await this.startMonitor();
    } else {
      void this.startLoginFlow();
    }
  }

  async stop(): Promise<void> {
    this.monitorAbort?.abort();
    this.monitorAbort = null;
    this.stopMux();
    // Clear every active typing indicator so a disconnecting bridge does
    // not leave a phantom "正在输入" on any user's chat.
    for (const userId of [...this.typingActive.keys()]) {
      this.endTyping(userId, "plugin-stop");
    }
  }

  /**
   * Restart the monitor with the current token (or begin QR login when no
   * token exists). Used by the settings page "重连" button and after
   * config changes that affect the gateway connection.
   */
  async reconnect(): Promise<{ ok: boolean; message: string }> {
    this.stop();
    this.token = loadToken(this.config.storageDir);
    if (this.token) {
      this.loginState = { phase: "logged-in", botId: this.token.accountId };
      await this.startMonitor();
      return { ok: true, message: `已重连 (Bot: ${this.token.accountId})` };
    }
    void this.startLoginFlow();
    return { ok: true, message: "未找到登录令牌，已开始扫码登录" };
  }

  /**
   * Force re-login: drop the stored token and start a fresh QR flow.
   */
  async relogin(): Promise<{ ok: boolean; message: string }> {
    this.stop();
    this.deleteToken();
    this.token = null;
    this.loginState = { phase: "idle" };
    void this.startLoginFlow();
    return { ok: true, message: "已开始重新扫码登录" };
  }

  /** Log out: stop the monitor and remove the stored token. */
  async logout(): Promise<{ ok: boolean; message: string }> {
    this.stop();
    this.deleteToken();
    this.token = null;
    this.loginState = { phase: "idle" };
    return { ok: true, message: "已退出登录" };
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
    for (const key of ["baseUrl", "cdnBaseUrl", "botType", "cwd", "textChunkLimit", "cardTimeoutMs"] as const) {
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
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    // Any incoming user message resets the WeChat gateway counter.
    this.wechatMsgCount.set(userId, 0);
    this.contextTokens.set(userId, contextToken);

    const user = this.state.ensureUser(userId, this.config.cwd);

    // Pending approval cards for the CURRENT session: the next text is
    // (almost always) a decision. Cards of other sessions do not capture
    // messages — the user must switch into that session first (a notice
    // was sent when the card arrived).
    const approvals = (this.pendingApprovals.get(userId) ?? []).filter(
      (c) => c.sessionId === user.sessionId,
    );
    if (approvals.length > 0) {
      const text = extractText(msg.item_list);
      if (text === null || text === "") {
        await this.sendReply(userId, "⚠️ 当前有权限卡待处理，请用文本回复（1 允许一次 / 2 拒绝，多张卡用 P1=1 P2=2）。");
        return;
      }
      await this.handleApprovalReply(userId, text);
      return;
    }

    // Pending question cards for the CURRENT session: same policy.
    const questions = (this.pendingQuestions.get(userId) ?? []).filter(
      (c) => c.sessionId === user.sessionId,
    );
    if (questions.length > 0) {
      const text = extractText(msg.item_list);
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
    const text = extractText(msg.item_list);
    const isNext = text !== null && parseNextCommand(text);
    const cached = this.outboundCache.get(userId);
    if (!isNext && cached && cached.length > 0) {
      await this.flushPending(userId);
    }

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);

    if (text) {
      if (isNext) {
        await this.flushPending(userId);
        return;
      }

      if (parseHelpCommand(text)) {
        await this.sendReply(userId, formatHelp());
        return;
      }

      const silent = parseSilentCommand(text);
      if (silent) {
        await this.handleSilentCommand(userId, silent.mode);
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

      const compactCmd = parseCompactCommand(text);
      if (compactCmd) {
        await this.handleCompactCommand(userId, user, compactCmd);
        return;
      }

      // Unrecognized slash command — hint, then forward to the agent.
      const slashHint = detectUnknownSlashCommand(text);
      if (slashHint) {
        await this.sendReply(userId, `⚠️ 未知命令 ${slashHint}，已作为文本转发给 agent。发送 /help 查看可用命令。`);
      }
    }

    await this.forwardToAgent(user, msg, contextToken);
  }

  private async forwardToAgent(user: UserState, msg: WeixinMessage, contextToken: string): Promise<void> {
    const agent = await this.agents.ensure(user);
    if (!agent) {
      await this.sendReply(user.userId, "⚠️ 无法创建/恢复 DSH 会话，请检查 DSH 日志。");
      return;
    }
    this.state.update(user.userId, { sessionId: user.sessionId });

    const tempDir = path.join(this.config.storageDir, "tempfile");
    const blocks = await weixinMessageToPrompt(msg, this.config.cdnBaseUrl, (m) => this.log(m), tempDir);
    // Give the message an explicit id so its `user/message` echo can be
    // recognized as WeChat-originated (and mark the session's source).
    const messageId = `wx-msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.markWechatMessage(messageId);
    this.markSessionSource(user.sessionId, "wechat");
    this.agents.followup(agent, blocks, messageId);
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
        const isWechat = inserted.some(
          (m) => typeof m?.id === "string" && m.id.startsWith("wx-msg-"),
        );
        this.markSessionSource(sessionId, isWechat ? "wechat" : "gui");
        // Trigger the native "正在输入" indicator for WeChat-bound turns.
        // Any next-turn splice on a WeChat-bound session means the agent is
        // about to run (agent.status flips to "running") — show typing
        // regardless of whether the trigger message came from WeChat or the
        // GUI; the WeChat-bound user is waiting either way.
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

    const user = this.userForAgent(sessionId);
    if (!user) return;

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
        break;
      }
    }
  }

  /** Notify the bound user of an agent error. */
  handleAgentError(agentId: string, error: unknown): void {
    const user = this.userForAgent(agentId);
    if (!user) return;
    this.endTyping(user.userId, "agent-error");
    void this.sendReply(user.userId, `⚠️ Agent 出错: ${String(error)}`).catch(() => {});
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
    if (!events) {
      console.warn("[dsh-wechat] apiProxy.events.mux unavailable; approval/question cards disabled");
      return;
    }

    const loop = async (): Promise<void> => {
      while (!this.muxAbort?.signal.aborted) {
        try {
          const abort = new AbortController();
          this.muxAbort = abort;
          const frames = events.mux({ rpcId: `wx-mux-${Date.now().toString(36)}`, payload: {} }, abort.signal);
          for await (const frame of frames) {
            if (abort.signal.aborted) break;
            this.handleMuxFrame(frame);
          }
          // Stream ended (server restart etc.): reopen.
          if (!abort.signal.aborted) {
            await new Promise((r) => setTimeout(r, 2000));
          }
        } catch (err) {
          console.error(`[dsh-wechat] mux stream error: ${String(err)}`);
          if (this.muxAbort?.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };
    void loop();
  }

  /** Stop the mux subscription (plugin dispose). */
  stopMux(): void {
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
        if (!userId) return;
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
        // The typing indicator stays on through card waits — agent.status
        // is still "running" until turn/end.
        const userState = this.state.getUser(userId);
        if (userState?.sessionId === sessionId) {
          void this.sendApprovalCard(userId, card, list.length).catch(() => {});
        } else {
          void this.notifyCardPending(userId, sessionId).catch(() => {});
        }
        break;
      }
      case "approval/resolved": {
        const approvalId = String(payload.approvalId ?? "");
        const outcome = String(payload.outcome ?? "");
        for (const [userId, list] of [...this.pendingApprovals.entries()]) {
          const entry = list.find((c) => c.approvalId === approvalId);
          if (!entry) continue;
          clearTimeout(entry.timer);
          this.pendingApprovals.set(
            userId,
            list.filter((c) => c.approvalId !== approvalId),
          );
          const label = outcome === "allowed-once" ? "✅ 已允许" : outcome === "rejected" ? "⛔ 已拒绝" : "🚫 已取消";
          void this.sendReply(userId, `🔒 权限请求结果：${label}（${entry.toolName}）`).catch(() => {});
          break;
        }
        break;
      }
      case "question/requested": {
        const sessionId = String(payload.sessionId ?? "");
        const questions = payload.questions as AskUserQuestionItem[] | undefined;
        if (!frame.rpcId || !sessionId || !Array.isArray(questions) || questions.length === 0) return;
        const userId = this.recipientForSession(sessionId);
        if (!userId) return;
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
        // Same current-session policy as approval cards. Typing indicator
        // stays on through card waits — agent.status is still "running".
        const userState = this.state.getUser(userId);
        if (userState?.sessionId === sessionId) {
          void this.sendQuestionCard(userId, card, questions, list.length).catch(() => {});
        } else {
          void this.notifyCardPending(userId, sessionId).catch(() => {});
        }
        break;
      }
      case "question/resolved": {
        const questionRpcId = String(payload.questionRpcId ?? "");
        const outcome = String(payload.outcome ?? "");
        for (const [userId, list] of [...this.pendingQuestions.entries()]) {
          const entry = list.find((c) => c.rpcId === questionRpcId);
          if (!entry) continue;
          clearTimeout(entry.timer);
          this.pendingQuestions.set(
            userId,
            list.filter((c) => c.rpcId !== questionRpcId),
          );
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
    if (!this.token || !this.contextTokens.has(userId)) return;
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
  }

  /** The WeChat user a card for `sessionId` goes to: its bound user, else the most recent active user. */
  private recipientForSession(sessionId: string): string | undefined {    const bound = this.userForAgent(sessionId);
    if (bound) return bound.userId;
    let latest: { userId: string; time: number } | undefined;
    for (const [userId, token] of this.contextTokens) {
      // contextTokens has no timestamp; fall back to last set order via insertion.
      latest = { userId, time: 0 };
    }
    void latest;
    // Prefer the first known user (single-user deployments are the norm).
    const users = this.state.all();
    return users[0]?.userId;
  }

  private isBoundSession(sessionId: string): boolean {
    return this.userForAgent(sessionId) !== undefined;
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
    if (parseHelpCommand(text)) {
      await this.sendReply(userId, formatHelp());
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
    if (entry) clearTimeout(entry.timer);
    const next = list.filter((c) => c.rpcId !== rpcId);
    if (next.length > 0) this.pendingApprovals.set(userId, next);
    else this.pendingApprovals.delete(userId);
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
    if (parseHelpCommand(text)) {
      await this.sendReply(userId, formatHelp());
      return; // cards stay pending
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
    if (entry) clearTimeout(entry.timer);
    const next = list.filter((c) => c.rpcId !== rpcId);
    if (next.length > 0) this.pendingQuestions.set(userId, next);
    else this.pendingQuestions.delete(userId);
  }

  // ─── Slash command handlers ───

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
        await this.switchUserWorkspace(user, ws.path);
        await this.sendReply(userId, `✅ 已添加并切换到工作区: ${ws.title} — ${ws.path}`);
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
        await this.switchUserWorkspace(user, ws.path);
        await this.sendReply(userId, `✅ 已切换到工作区: ${ws.title} — ${ws.path}`);
        return;
      }
    }
  }

  /**
   * Rebind the user to the workspace's most recent session (or create a
   * fresh one in that directory when none is recoverable).
   */
  private async switchUserWorkspace(user: UserState, workspacePath: string): Promise<void> {
    user.cwd = workspacePath;
    user.cwdExplicit = true;
    user.sessionId = "";
    // Prefer the workspace's newest candidate session.
    const ws = this.ops.listWorkspaces().find((w) => w.path === workspacePath);
    const candidate = ws?.sessionIds[0];
    if (candidate) {
      user.sessionId = candidate;
    }
    this.state.update(user.userId, { cwd: workspacePath, cwdExplicit: true, sessionId: user.sessionId });
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
        for (let i = 0; i < recent.length; i++) {
          const record = recent[i]!;
          const marker = record.header.id === user.sessionId ? " ◀ 当前" : "";
          const title = cleanSessionTitle(
            (await this.ops.readSessionTitle(record.header.id)) ?? record.header.id.slice(0, 12),
          );
          const when = this.formatRelativeTime(this.sessionActivityTime(record));
          // One line per entry: WeChat renders `\n` in BOT text unreliably
          // (entries collapse together), so every field rides the same line
          // and each entry stays identifiable by its `N.` prefix.
          lines.push(
            `${i + 1}. ${title}${marker} — ${record.header.cwd ?? "?"} · ${when}${record.header.agentPreset ? ` · Preset:${record.header.agentPreset}` : ""}`,
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
        const agent = await this.agents.ensure(user);
        await this.sendReply(userId, `✅ 已切换到会话 ${record.header.id.slice(0, 12)}（${record.header.cwd ?? "?"}）${agent ? `，Agent ${agent.status}` : ""}。`);
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
          const agent = await this.agents.ensure(user);
          await this.sendReply(userId, `✅ 已复用空白会话 ${blank.slice(0, 12)}（${user.cwd}）${agent ? `，Agent ${agent.status}` : ""}。`);
          return;
        }
        user.sessionId = "";
        this.state.update(user.userId, { sessionId: "" });
        const agent = await this.agents.ensure(user);
        this.state.update(user.userId, { sessionId: user.sessionId });
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
        const agent = this.agents.get(user);
        await this.sendReply(
          userId,
          `🤖 Preset: ${await this.resolveEffectivePreset(user)}\nAgent: ${agent ? agent.status : "未加载"}`,
        );
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
        const lines = [`🧠 ${active!.provider}/${active!.model} 的推理等级（/reasoning <等级> 切换）`];
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

  // ─── Compaction ───

  /**
   * `/compact` — manually trigger one compaction of the current session.
   *
   * Dispatches through the global `commands` service so the registered
   * `dsh-command-compact` handler runs unchanged: this is the same code
   * path the GUI's command palette uses, with the same `command/run` ↔
   * `command/done` lifecycle events and the same `ManualCompactionError`
   * classification. Background: the WeChat slice intentionally reuses the
   * GUI command surface — sound architectural mirroring, no bridge-owned
   * error translation to drift out of sync.
   */
  private async handleCompactCommand(userId: string, user: UserState, cmd: CompactCommand): Promise<void> {
    const agent = this.agents.get(user);
    if (!agent) {
      await this.sendReply(userId, "⚠️ 当前没有可用会话。先发一条消息或 /session new 创建会话，再 /compact。");
      return;
    }
    // Match the underlying handler's strictness: any trailing input becomes
    // its usage error message, so the GUI and WeChat render the same reply.
    if (cmd.extra.length > 0) {
      await this.sendReply(userId, "⚠️ Usage: /compact (no arguments)");
      return;
    }
    const commands = this.ops.commands();
    if (!commands) {
      await this.sendReply(userId, "⚠️ 当前部署未挂载 dsh-command-compact，无法压缩。");
      return;
    }
    const abort = new AbortController();
    try {
      const execution = await commands.execute(agent, "/compact", abort.signal);
      if (!execution) {
        // `/compact` is a registered name; `execute` returns undefined only on
        // syntax miss (impossible here) or unknown name. Defensive reply.
        await this.sendReply(userId, "⚠️ 内部错误: /compact 未注册到 dsh-commands。");
        return;
      }
      const { result } = execution;
      if (result.kind === "success") {
        await this.sendReply(userId, `✅ ${result.text ?? "压缩完成"}`);
      } else {
        await this.sendReply(userId, `⚠️ ${result.text}`);
      }
    } catch (err) {
      await this.sendReply(userId, `⚠️ 压缩失败: ${String(err)}`);
      console.error(`[dsh-wechat] /compact failed: ${String(err)}`);
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
        if (agent) {
          this.modelOverrides.set(agent.id, { provider: matchedProvider.id, model: matchedModel.id });
        }
        const saved = await this.ops.saveDefaultModel({ provider: matchedProvider.id, model: matchedModel.id });
        const lines = [`✅ 已切换到模型: ${matchedProvider.id}/${matchedModel.id}`];
        if (agent) lines.push("（已应用到当前会话，下一步生效）");
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

    const lines = [
      "📊 当前状态",
      `• 工作区: ${user.cwd}`,
      `• 会话: ${sessionLabel}`,
      `• Agent: ${agent ? agent.status : "（未加载）"}`,
      `• Preset: ${await this.resolveEffectivePreset(user)}`,
      `• 模型: ${active?.provider && active?.model ? `${active.provider}/${active.model}${effortSuffix}` : "（默认）"}`,
      ...(contextLabel ? [contextLabel] : []),
      ...(permission ? [`• 权限: ${permission}`] : []),
      `• 静默模式: ${user.silent ? "on" : "off"}`,
    ];
    return lines.join("\n");
  }

  /**
   * The preset actually composing the user's session: the session header's
   * recorded preset (fixed at creation), else the roster/settings default.
   * The settings document (`agent-presets` namespace) is the single source
   * of truth for the default; the header records what a specific session
   * actually runs. Falls back to "（默认）" when none is discoverable.
   */
  private async resolveEffectivePreset(user: UserState): Promise<string> {
    let preset: string | undefined;
    if (user.sessionId) {
      const sessions = await this.ops.listSessions();
      preset = sessions.find((r) => r.header.id === user.sessionId)?.header.agentPreset;
    }
    if (!preset) {
      const defaultPreset = this.ops.defaultPresetId();
      if (defaultPreset) return `${defaultPreset}（默认）`;
    }
    return preset ?? "（默认）";
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
   */
  private resolveEffectiveModel(
    user: UserState,
    agent: Agent | undefined,
  ): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
    const override = agent ? this.modelOverrides.get(agent.id) : undefined;
    if (override) return override;
    const logged = agent?.session?.requestHeader?.()?.config;
    if (logged?.provider && logged.model) return logged;
    if (agent?.options?.provider && agent.options.model) return agent.options;
    return this.ops.defaultModelSelection();
  }

  // ─── send-wechat tool ───

  /**
   * Handle the `send_wechat` tool: push text or a local file to the
   * bound WeChat user. Returns a plain JSON value for the tool result.
   */
  async handleSendWeChat(agentId: string, args: { text?: string; file_path?: string }): Promise<{ ok: boolean; message: string }> {
    const user = this.userForAgent(agentId);
    if (!user) {
      return { ok: false, message: "no WeChat user is bound to this session" };
    }
    const contextToken = this.contextTokens.get(user.userId);
    if (!contextToken) {
      return { ok: false, message: "user has not messaged yet; a context token is required to send" };
    }
    if (!this.token) {
      return { ok: false, message: "WeChat is not logged in" };
    }

    const sendOpts = {
      baseUrl: this.token.baseUrl,
      token: this.token.token,
      contextToken,
    };

    try {
      if (args.file_path) {
        const buffer = await import("node:fs/promises").then((fs) => fs.readFile(args.file_path!));
        const fileName = args.file_path.split(/[\\/]/).pop() ?? "file";
        // Send images/videos with their native media type so WeChat renders
        // them inline; everything else goes as a file attachment.
        const mediaType = mediaTypeForFile(fileName);
        await sendMediaMessage(user.userId, mediaType, buffer, {
          ...sendOpts,
          cdnBaseUrl: this.config.cdnBaseUrl,
          fileName,
        });
        const kind = mediaType === UploadMediaType.IMAGE ? "image" : mediaType === UploadMediaType.VIDEO ? "video" : "file";
        return { ok: true, message: `sent ${kind} ${fileName}` };
      }
      if (args.text) {
        const segments = splitText(args.text, this.config.textChunkLimit);
        for (const segment of segments) {
          await sendTextMessage(user.userId, segment, sendOpts);
        }
        return { ok: true, message: `sent ${segments.length} message(s)` };
      }
      return { ok: false, message: "provide either text or file_path" };
    } catch (err) {
      return { ok: false, message: `send failed: ${String(err)}` };
    }
  }

  // ─── Outbound sending (WeChat gateway limits) ───
  /** Cached-message notice already shown for this user (avoids recursion). */
  private readonly cacheNoticeSent = new Set<string>();

  private async sendReply(userId: string, text: string): Promise<void> {
    if (!this.token || !this.contextTokens.has(userId)) {
      this.log(`sendReply skipped (not logged in / no context token for ${userId}): ${text.slice(0, 60)}`);
      return;
    }
    const formatted = formatForWeChat(text);
    const segments = splitText(formatted, this.config.textChunkLimit);
    const cache = this.outboundCache.get(userId) ?? [];
    let limitCached = false;

    for (const segment of segments) {
      const count = this.wechatMsgCount.get(userId) ?? 0;
      if (count >= MSG_LIMIT_MAX) {
        cache.push({ kind: "text", text: segment });
        limitCached = true;
        continue;
      }
      this.wechatMsgCount.set(userId, count + 1);
      const payload =
        count + 1 > MSG_LIMIT_WARN
          ? segment + `\n\n⚠️ 微信限制连续发送消息数量10条（已发 ${count + 1} 条），发送 /next 可继续`
          : segment;
      try {
        await sendTextMessage(userId, payload, {
          baseUrl: this.token.baseUrl,
          token: this.token.token,
          contextToken: this.contextTokens.get(userId)!,
        });
      } catch (err) {
        this.log(`send reply error: ${String(err)}`);
        cache.push({ kind: "text", text: segment });
      }
    }
    if (cache.length > 0) this.outboundCache.set(userId, cache);

    if (limitCached && !this.cacheNoticeSent.has(userId)) {
      this.cacheNoticeSent.add(userId);
      const notice = `💾 有 ${cache.length} 条消息因微信限制被缓存，发送 /next 可继续发送。`;
      try {
        await sendTextMessage(userId, notice, {
          baseUrl: this.token.baseUrl,
          token: this.token.token,
          contextToken: this.contextTokens.get(userId)!,
        });
      } catch {
        this.cacheNoticeSent.delete(userId);
      }
    }
  }

  /** Flush cached outbound messages (`/next` or auto on new user message). */
  private async flushPending(userId: string): Promise<void> {
    const cache = this.outboundCache.get(userId);
    if (!cache || cache.length === 0) {
      await this.sendReply(userId, "✅ 没有缓存的消息。");
      return;
    }
    this.wechatMsgCount.set(userId, 0);
    const remaining: CachedMessage[] = [];
    for (const msg of cache) {
      const count = this.wechatMsgCount.get(userId) ?? 0;
      if (count >= MSG_LIMIT_MAX) {
        remaining.push(msg);
        continue;
      }
      this.wechatMsgCount.set(userId, count + 1);
      try {
        if (msg.kind === "text") {
          await sendTextMessage(userId, msg.text, {
            baseUrl: this.token!.baseUrl,
            token: this.token!.token,
            contextToken: this.contextTokens.get(userId)!,
          });
        } else {
          const buffer = await import("node:fs/promises").then((fs) => fs.readFile(msg.filePath));
          await sendMediaMessage(userId, UploadMediaType.FILE, buffer, {
            baseUrl: this.token!.baseUrl,
            token: this.token!.token,
            contextToken: this.contextTokens.get(userId)!,
            cdnBaseUrl: this.config.cdnBaseUrl,
            fileName: msg.fileName,
          });
        }
      } catch (err) {
        this.log(`flush send error: ${String(err)}`);
        remaining.push(msg);
      }
    }
    if (remaining.length > 0) {
      this.outboundCache.set(userId, remaining);
      await this.sendReply(userId, `✅ 已发送 ${cache.length - remaining.length} 条，剩余 ${remaining.length} 条缓存，/next 继续。`);
    } else {
      this.outboundCache.delete(userId);
      await this.sendReply(userId, `✅ 全部 ${cache.length} 条缓存消息已发送。`);
    }
  }

  // ─── Helpers ───

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
