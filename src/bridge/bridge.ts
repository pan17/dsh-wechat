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
import { MessageType, UploadMediaType } from "../weixin/types.js";
import type { WeixinMessage } from "../weixin/types.js";
import { extractText, weixinMessageToPrompt } from "../adapter/inbound.js";
import { formatForWeChat } from "../adapter/outbound.js";
import { formatQuestionForWeChat, parseQuestionReply, buildAnswer } from "../adapter/question-format.js";
import { formatApprovalCard, parseApprovalReply } from "../adapter/approval-format.js";
import { AgentStore, type BridgeContext } from "../dsh/sessions.js";
import { DshOps } from "../dsh/ops.js";
import type { AskUserQuestionAnswer, AskUserQuestionItem } from "../dsh/types.js";
import { StateStore, type UserState } from "../state.js";
import type { WeChatDSHConfig } from "../config.js";
import {
  detectUnknownSlashCommand,
  formatHelp,
  parseAgentCommand,
  parseHelpCommand,
  parseModelCommand,
  parseRejectPermissionCommand,
  parseRejectQuestionCommand,
  parseSessionCommand,
  parseSilentCommand,
  parseStatusCommand,
  parseStopCommand,
  parseWorkspaceCommand,
  type AgentCommand,
  type ModelCommand,
  type SessionCommand,
  type WorkspaceCommand,
} from "./slash.js";

/** WeChat gateway continuous-message limit per user interaction window. */
const MSG_LIMIT_MAX = 10;
const MSG_LIMIT_WARN = 5;

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
  /** Per-agent model overrides set by `/model switch` (applied via agent/request). */
  private readonly modelOverrides = new Map<string, { provider: string; model: string }>();
  /** apiProxy for respond() injection; set by attachMux. */
  private apiProxy: ApiProxySurface | null = null;
  private muxAbort: AbortController | null = null;

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
    for (const key of ["baseUrl", "cdnBaseUrl", "botType", "cwd", "agentPreset", "textChunkLimit", "cardTimeoutMs"] as const) {
      editable[key] = this.config[key];
    }
    return {
      ...this.loginState,
      monitorRunning: this.monitorRunning,
      userCount: this.state.all().length,
      config: editable,
    };
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
    for (const key of ["baseUrl", "cdnBaseUrl", "botType", "cwd", "agentPreset", "textChunkLimit", "cardTimeoutMs"] as const) {
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

    // Pending approval cards: the next text is (almost always) a decision.
    const approvals = this.pendingApprovals.get(userId);
    if (approvals && approvals.length > 0) {
      const text = extractText(msg.item_list);
      if (text === null || text === "") {
        await this.sendReply(userId, "⚠️ 当前有权限卡待处理，请用文本回复（1 允许一次 / 2 拒绝，多张卡用 P1=1 P2=2）。");
        return;
      }
      await this.handleApprovalReply(userId, text);
      return;
    }

    // Pending question cards: the next text is (almost always) the answer.
    const questions = this.pendingQuestions.get(userId);
    if (questions && questions.length > 0) {
      const text = extractText(msg.item_list);
      if (text === null || text === "") {
        await this.sendReply(userId, "⚠️ 当前有提问卡待处理，请用文本回复（数字或自定义文字，例如 `Q1=1` 或 `Q1-我的想法`）。");
        return;
      }
      await this.handleQuestionReply(userId, text);
      return;
    }

    // Auto-flush cached outbound on any user message.
    const cached = this.outboundCache.get(userId);
    if (cached && cached.length > 0) {
      await this.flushPending(userId);
    }

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);

    const text = extractText(msg.item_list);
    if (text) {
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
        await this.sendReply(userId, this.formatStatus(user));
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

      const aCmd = parseAgentCommand(text);
      if (aCmd) {
        await this.handleAgentCommand(userId, aCmd);
        return;
      }

      const mCmd = parseModelCommand(text);
      if (mCmd) {
        await this.handleModelCommand(userId, mCmd);
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
    const agent = await this.agents.ensure(user, this.config.agentPreset);
    if (!agent) {
      await this.sendReply(user.userId, "⚠️ 无法创建/恢复 DSH 会话，请检查 DSH 日志。");
      return;
    }
    this.state.update(user.userId, { sessionId: user.sessionId });

    const tempDir = path.join(this.config.storageDir, "tempfile");
    const blocks = await weixinMessageToPrompt(msg, this.config.cdnBaseUrl, (m) => this.log(m), tempDir);
    this.agents.followup(agent, blocks);
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
        break;
      }
    }
  }

  /** Notify the bound user of an agent error. */
  handleAgentError(agentId: string, error: unknown): void {
    const user = this.userForAgent(agentId);
    if (!user) return;
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
        void this.sendReply(
          userId,
          formatApprovalCard(card, list.length, list.length) +
            (this.isBoundSession(sessionId) ? "" : `\n\n（会话 ${sessionId.slice(0, 12)} — 未绑定微信，可直接在此处理）`),
        ).catch(() => {});
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
        const header =
          list.length > 1 ? `❓ 提问卡 ${list.length}/${list.length}` : "❓ 提问";
        void this.sendReply(userId, `${header}\n${formatQuestionForWeChat(questions)}`).catch(() => {});
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

  /** The WeChat user a card for `sessionId` goes to: its bound user, else the most recent active user. */
  private recipientForSession(sessionId: string): string | undefined {
    const bound = this.userForAgent(sessionId);
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
    const list = this.pendingApprovals.get(userId);
    if (!list || list.length === 0) return;

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

  /** `/rp` — reject every pending approval card on WeChat. */
  private async rejectAllApprovals(userId: string): Promise<void> {
    const list = this.pendingApprovals.get(userId);
    if (!list || list.length === 0) {
      await this.sendReply(userId, "✅ 当前没有待处理的权限卡。");
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
    const list = this.pendingQuestions.get(userId);
    if (!list || list.length === 0) return;

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

  /** `/rq` — reject every pending question card on WeChat. */
  private async rejectPendingQuestion(userId: string): Promise<void> {
    const list = this.pendingQuestions.get(userId);
    if (!list || list.length === 0) {
      await this.sendReply(userId, "✅ 当前没有待处理的问题卡。");
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
        const lines = ["📂 工作区列表（按最近使用排序）"];
        workspaces.forEach((ws, i) => {
          const current = user.cwd === ws.path ? " ◀ 当前" : "";
          lines.push(`${i + 1}. ${ws.title} — ${ws.path}（${ws.sessionIds.length} 会话）${current}`);
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
        const recent = sessions
          .sort((a, b) => b.header.createdAt - a.header.createdAt)
          .slice(0, 20);
        const lines = ["💬 最近会话（/session switch <编号> 切换）"];
        for (let i = 0; i < recent.length; i++) {
          const record = recent[i]!;
          const marker = record.header.id === user.sessionId ? " ◀ 当前" : "";
          const title = cleanSessionTitle(
            (await this.ops.readSessionTitle(record.header.id)) ?? record.header.id.slice(0, 12),
          );
          const when = new Date(record.header.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
          lines.push(`${i + 1}. ${title}${marker}`);
          lines.push(`   ${record.header.cwd ?? "?"} · ${when}${record.header.agentPreset ? ` · 模式:${record.header.agentPreset}` : ""}`);
        }
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "switch": {
        const sessions = await this.ops.listSessions();
        const recent = sessions.sort((a, b) => b.header.createdAt - a.header.createdAt);
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
        const agent = await this.agents.ensure(user, user.agentPreset ?? this.config.agentPreset);
        await this.sendReply(userId, `✅ 已切换到会话 ${record.header.id.slice(0, 12)}（${record.header.cwd ?? "?"}）${agent ? `，Agent ${agent.status}` : ""}。`);
        return;
      }
      case "new": {
        user.sessionId = "";
        this.state.update(user.userId, { sessionId: "" });
        const agent = await this.agents.ensure(user, user.agentPreset ?? this.config.agentPreset);
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

  private async handleAgentCommand(userId: string, cmd: AgentCommand): Promise<void> {
    const user = this.state.ensureUser(userId, this.config.cwd);
    switch (cmd.kind) {
      case "list": {
        const presets = (await this.ops.listPresets()).filter((p) => !p.broken);
        if (presets.length === 0) {
          await this.sendReply(userId, "🤖 暂无可用 Agent 模式。");
          return;
        }
        const current = user.agentPreset ?? this.config.agentPreset;
        const lines = ["🤖 可用 Agent 模式（/agent switch <名称|编号>）"];
        presets.forEach((preset, i) => {
          const marker = preset.id === current ? " ◀ 当前" : "";
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
            await this.sendReply(userId, `⚠️ 未知模式: ${cmd.target}。用 /agent list 查看。`);
            return;
          }
        }
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
          applied = "（当前会话已有内容，模式将应用于下一个新会话）";
        }
        user.agentPreset = preset.id;
        this.state.update(user.userId, { agentPreset: preset.id });
        await this.sendReply(userId, `✅ 已切换模式: ${preset.name ?? preset.id}${applied}。`);
        return;
      }
      case "status": {
        const agent = this.agents.get(user);
        const preset = user.agentPreset ?? this.config.agentPreset ?? "（默认）";
        await this.sendReply(userId, `🤖 模式: ${preset}\nAgent: ${agent ? agent.status : "未加载"}`);
        return;
      }
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
          const lines = [`🧠 ${provider.name} 的模型（/model switch ${provider.id}/<模型>）`];
          models.forEach((model, i) => {
            lines.push(`${i + 1}. ${model.name} — ${model.id}${model.description ? `（${model.description}）` : ""}`);
          });
          await this.sendReply(userId, lines.join("\n"));
          return;
        }
        const lines = ["🧠 模型提供商（/model list <提供商> 查看模型）"];
        providers.forEach((p, i) => lines.push(`${i + 1}. ${p.name} — ${p.id}`));
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "switch": {
        const [provider, model] = cmd.target.split("/");
        const providers = this.ops.listProviders();
        if (!providers.some((p) => p.id === provider)) {
          await this.sendReply(userId, `⚠️ 未知提供商: ${provider}。可用: ${providers.map((p) => p.id).join(", ")}`);
          return;
        }
        const models = await this.ops.listModels(provider!);
        if (!models.some((m) => m.id === model)) {
          await this.sendReply(userId, `⚠️ 未知模型: ${model}。用 /model list ${provider} 查看可用模型。`);
          return;
        }
        // Apply to the live agent (via agent/request) and as the new default.
        const agent = this.agents.get(user);
        if (agent) {
          this.modelOverrides.set(agent.id, { provider: provider!, model: model! });
        }
        const saved = await this.ops.saveDefaultModel({ provider: provider!, model: model! });
        const lines = [`✅ 已切换到模型: ${provider}/${model}`];
        if (agent) lines.push("（已应用到当前会话，下一步生效）");
        if (!saved) lines.push("⚠️ 无法更新默认模型（仅当前会话生效）");
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "status": {
        const agent = this.agents.get(user);
        const defaultModel = this.ops.defaultModelSelection();
        const override = agent ? this.modelOverrides.get(agent.id) : undefined;
        const lines = ["🧠 模型状态"];
        if (agent) {
          const active = override ?? agent.options;
          if (active?.provider && active?.model) {
            lines.push(`• 当前会话: ${active.provider}/${active.model}`);
          } else if (agent.options) {
            lines.push(`• 当前会话: ${JSON.stringify(agent.options)}`);
          }
        }
        if (defaultModel) {
          lines.push(`• 默认: ${defaultModel.provider}/${defaultModel.model}`);
        }
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
    }
  }

  /**
   * Apply the user's model override to a frozen request config. Called from
   * the `agent/request` waterfall listener (registered in index.ts) for
   * WeChat-bound agents.
   */
  applyModelOverride(config: { provider: string; model: string }, agentId: string): { provider: string; model: string } {
    const override = this.modelOverrides.get(agentId);
    if (!override) return config;
    return { ...config, provider: override.provider, model: override.model };
  }

  private formatStatus(user: UserState): string {
    const agent = this.agents.get(user);
    const override = agent ? this.modelOverrides.get(agent.id) : undefined;
    const active = override ?? agent?.options;
    const model = active?.provider && active?.model ? `${active.provider}/${active.model}` : "（默认）";
    const preset = user.agentPreset ?? this.config.agentPreset ?? "（默认）";
    const lines = [
      "📊 当前状态",
      `• 工作区: ${user.cwd}`,
      `• 会话: ${user.sessionId || "（未绑定）"}`,
      `• Agent: ${agent ? agent.status : "（未加载）"}`,
      `• 模式: ${preset}`,
      `• 模型: ${model}`,
      `• 静默模式: ${user.silent ? "on" : "off"}`,
      "• 权限审批: DSH 原生（GUI 权限卡）",
    ];
    return lines.join("\n");
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
        await sendMediaMessage(user.userId, UploadMediaType.FILE, buffer, {
          ...sendOpts,
          cdnBaseUrl: this.config.cdnBaseUrl,
          fileName,
        });
        return { ok: true, message: `sent file ${fileName}` };
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
