/**
 * The core bridge: WeChat iLink ⇄ DSH agents.
 *
 * Ported design from wechat-opencode (MIT) — https://github.com/pan17/wechat-opencode
 * The OpenCode Server half is replaced by direct in-process DSH service
 * calls: agents are created/resumed through the `agents` registry, WeChat
 * messages enter via `agent.followup`, assistant output leaves via the
 * `session/event` feed, and approval/question cards are MIRRORED to WeChat
 * from the Host `approval/request` and `user-questions/request` waterfalls
 * — the decision point and trigger policy stay exactly as in the GUI
 * (`approval.request` from sandbox escalation, `userQuestions.ask` from
 * the native ask tool). The bridge races `next()` (GUI / other answerers)
 * against the WeChat reply. Whoever answers first wins; there is no
 * custom approval list.
 */

import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { login, loadToken, type TokenData } from "../weixin/auth.js";
import { startMonitor, clearSyncBuf } from "../weixin/monitor.js";
import { sendTextMessage, sendMediaMessage, splitText } from "../weixin/send.js";
import {
  sendTyping as apiSendTyping,
  getConfig as apiGetConfig,
  isInvalidRequestError,
  isMessageLimitError,
  isSessionTimeoutError,
} from "../weixin/api.js";
import { MessageItemType, MessageType, TypingStatus, UploadMediaType } from "../weixin/types.js";
import type { WeixinMessage } from "../weixin/types.js";
import { extractText, weixinMessageToPrompt } from "../adapter/inbound.js";
import { formatForWeChat } from "../adapter/outbound.js";
import { ExecutionProcess } from "../adapter/process-format.js";
import type { AssistantStreamFrame, OutputContentBlock, ToolCallData, ToolResultData } from "../dsh/types.js";
import { formatQuestionForWeChat, parseQuestionReply, buildAnswer } from "../adapter/question-format.js";
import { formatApprovalCard, parseApprovalReply } from "../adapter/approval-format.js";
import { AgentStore, type BridgeContext } from "../dsh/sessions.js";
import { DshOps } from "../dsh/ops.js";
import type { ModelSelection, PinOutcome, SessionRecord } from "../dsh/ops.js";
import type { Agent, AskUserQuestionAnswer, AskUserQuestionItem } from "../dsh/types.js";
import { sessionEvents } from "../dsh/types.js";
import {
  MAX_OUTBOUND_QUEUE,
  MAX_OUTBOUND_QUEUE_HARD,
  StateStore,
  type OutboundMessage,
  type UserState,
} from "../state.js";
import type { WeChatDSHConfig } from "../config.js";
import { defaultConfig } from "../config.js";
import { EDITABLE_KEYS, type ConfigStore, type EditableConfig } from "../config-store.js";
import { maskSecrets, maskUserId } from "../utils/redact.js";
import { AuditLog } from "../utils/audit.js";
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
  parseFinalCommand,
  parseMergeCommand,
  parseModelCommand,
  splitProviderModelTarget,
  parseNextCommand,
  parseFlushCommand,
  parseNotifyCommand,
  parsePermCommand,
  parsePresetCommand,
  parseReasoningCommand,
  parseAllPnCardReplies,
  parsePnCardReply,
  parseRejectPermissionCommand,
  parseRejectQuestionCommand,
  parseSessionCommand,
  parseSilentCommand,
  parseSurfaceCommand,
  parseStatusCommand,
  parseStopCommand,
  parseWorkspaceCommand,
  HISTORY_MAX,
  LIST_DEFAULT,
  LOCAL_COMMAND_NAMES,
  type EnterCommand,
  type FinalCommand,
  type HistoryCommand,
  type MergeCommand,
  type ModelCommand,
  type NotifyCommand,
  type SurfaceCommand,
  type PermCommand,
  type PresetCommand,
  type ReasoningCommand,
  type SessionCommand,
  type WorkspaceCommand,
} from "./slash.js";

/** WeChat gateway continuous-message limit per user interaction window. */
const MSG_LIMIT_MAX = 10;
const MSG_LIMIT_WARN = 7;
/**
 * Code points of an assistant message quoted in a cross-session notice.
 * The CONCLUSION lives at the END of an assistant message, so the quote is
 * taken from the tail: a head excerpt shows the preamble ("let me look at
 * the file…") in exactly the case the notice exists to summarise.
 */
const PREVIEW_CHARS = 80;
/** Bound memory for service-identified inbound replays; equal text is never a key. */
const INBOUND_TTL_MS = 30 * 60_000;
const INBOUND_MAX_SEEN = 4096;
/** How long a session's message-source marker stays valid without a touch. */
const SURFACE_TTL_MS = 7 * 24 * 60 * 60_000;
/**
 * Bounded wait for the outbound serialization slot (R1). A single hung
 * outbound operation must not wedge every later send forever: when the
 * predecessor does not settle within this window, the waiter logs loudly and
 * proceeds WITHOUT the slot (the alternative — waiting forever — is the
 * failure this bound exists to prevent). 30s is far above any real gateway
 * call (the send itself has its own HTTP timeout) and far below "wedged".
 */
const OUTBOUND_SLOT_WAIT_MS = 30_000;
/**
 * Hard caps for the per-session memo maps (R2). These are caches, not queues:
 * nothing is lost when an entry is evicted (a preview simply shows the session
 * id instead of a quoted tail, `/s list` falls back to the session's creation
 * time, a model override falls back to the deployment default). The caps are
 * insertion-ordered FIFO — deterministic and allocation-free — rather than
 * true LRU: the readers are `/s list` (a window over the roster) and `/status`
 * (one row), so read-recency would not predict what is needed next.
 */
const ASSISTANT_PREVIEW_MAX_SESSIONS = 64;
const ACTIVITY_MAX_SESSIONS = 512;
const MODEL_OVERRIDE_MAX_SESSIONS = 128;
/**
 * One-shot TTL for a WeChat-injected message id. The mark is consumed by the
 * `user/message` echo; an echo that never arrives (turn cancelled, agent
 * never claimed the inbox item) must not pin the id for the process lifetime.
 * Generous because queue-mode delivery can take minutes while the agent is
 * busy — dropping the mark early would mislabel the next turn as GUI-driven
 * and silently drop the WeChat surface prompt for it.
 */
const WECHAT_MSG_ID_TTL_MS = 10 * 60_000;
const WECHAT_MSG_IDS_MAX = 512;
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

/** Closed approval outcomes the Host waterfall accepts. */
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

/**
 * Host `approval/request` waterfall payload (structural). `agent.id` is the
 * live session id; `callId` correlates the GUI tool card when present.
 */
export interface ApprovalRequestLike {
  readonly agent?: { readonly id?: string; session?: { header?: { id?: string } } };
  readonly toolName?: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

/**
 * Host `user-questions/request` waterfall payload (structural).
 */
export interface QuestionRequestLike {
  readonly agent?: { readonly id?: string; session?: { header?: { id?: string } } };
  readonly questions?: AskUserQuestionItem[];
  readonly signal?: AbortSignal;
}

/**
 * One pending question card mirrored from a `user-questions/request`.
 * WeChat answers settle `settleWechat`; GUI answers arrive via `next()`.
 */
interface PendingQuestion {
  rpcId: string;
  sessionId: string;
  userId: string;
  items: AskUserQuestionItem[];
  askedAt: number;
  timer: NodeJS.Timeout;
  settled: boolean;
  settleWechat: ((answer: AskUserQuestionAnswer) => void) | null;
  cancelWechat: ((reason: unknown) => void) | null;
}

/**
 * One held conclusion for a session under 结论模式 (`config.finalOnly`).
 * The entry accumulates instead of sending: `body` keeps the latest full
 * assistant text, `notice` the preview a cross-session completion card would
 * have carried, and `rounds` counts how many turn ends were folded in, so the
 * delivered digest can say how many rounds it stands for.
 */
interface PendingFinal {
  sessionId: string;
  /** Recipient the digest is delivered to (re-resolved from the bound user). */
  userId: string;
  /** Latest full assistant body held for this task; wins over `notice`. */
  body: string;
  /** Cross-session completion preview; used only while no `body` exists. */
  notice: string;
  /** Turn ends folded into this entry (1 = a single ordinary turn). */
  rounds: number;
  /** When the first hold happened — the hard ceiling is measured from here. */
  firstAt: number;
  /** Last activity; informational only (the timers are authoritative). */
  lastAt: number;
  /** Quiescence timer: fires `finalOnlyIdleMs` after the last activity. */
  settle?: NodeJS.Timeout;
  /** Hard ceiling timer: fires `finalOnlyCeilingMs` after `firstAt`. */
  ceiling?: NodeJS.Timeout;
}

/**
 * Per-chat merge state (打字合并).
 *
 * Entries are appended in arrival order and joined with newlines into ONE
 * prompt. `newestSourceAt` is the newest message timestamp seen (or arrival
 * time when iLink supplied none) and exists for exactly one rule: an
 * OUT-OF-ORDER older message must not extend the silence timer — otherwise a
 * late replay could hold a batch open indefinitely while the user waits.
 *
 * `silence` is absent while a `..` suffix holds the batch open; `ceiling` is
 * the forced release that always exists, so no batch can outlive
 * {@link WeChatDSHBridge.mergeForcedReleaseMs} regardless of suffixes,
 * message storms or a previous batch that never settles.
 */
interface MergeState {
  userId: string;
  entries: string[];
  /** Newest source timestamp seen (the out-of-order guard compares against it). */
  newestSourceAt: number;
  /** When the batch opened — reported by `/merge status` (never write-only). */
  firstAt: number;
  silence?: NodeJS.Timeout;
  ceiling?: NodeJS.Timeout;
  /** `..` seen: keep appending, no silence flush until the cap/`!!`/ceiling. */
  holdOpen: boolean;
  /** In-flight dispatch of this chat's previous batch (ordering barrier). */
  inFlight: Promise<void> | null;
}

/**
 * One pending approval card mirrored from an `approval/request`.
 * Identical information and choices to the GUI card; whoever answers
 * first (GUI click or WeChat reply) wins.
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
  settled: boolean;
  settleWechat: ((outcome: "allowed-once" | "rejected") => void) | null;
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
 * `systemPrompt`.
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

/**
 * The LAST `count` code points of `text`, plus whether anything was cut.
 *
 * "Last N characters" cannot be `slice(-N)`: that counts UTF-16 units, so
 * a tail beginning with an astral character (most emoji) starts on a lone
 * low surrogate. WeChat shows that as U+FFFD, and the excerpt would be
 * visibly corrupted at exactly the boundary this helper exists to pick.
 * The walk runs backwards from the end, so a multi-kilobyte message costs
 * nothing beyond the code points actually kept.
 *
 * The `truncated` flag is returned rather than inferred by the caller:
 * `tail.length < text.length` compares code points against UTF-16 units and
 * turns false the moment the message contains an emoji, silently dropping
 * the ellipsis that tells the reader the quote is partial.
 */
function tailByCodePoint(text: string, count: number): { tail: string; truncated: boolean } {
  if (count <= 0) return { tail: "", truncated: text.length > 0 };
  let start = text.length;
  let taken = 0;
  while (start > 0 && taken < count) {
    const code = text.charCodeAt(start - 1);
    const high = start >= 2 ? text.charCodeAt(start - 2) : 0;
    if (code >= 0xdc00 && code <= 0xdfff && high >= 0xd800 && high <= 0xdbff) {
      start -= 2;
    } else {
      start -= 1;
    }
    taken += 1;
  }
  return { tail: text.slice(start), truncated: start > 0 };
}

/**
 * Sliding 60-second limiter for agent-initiated `send_wechat` pushes.
 *
 * A sliding window, not a fixed bucket: a bucket would let 2× the limit
 * through across a bucket boundary, and the thing being protected is
 * WeChat's own 10-message gateway window, which is also a rolling window.
 * Timestamps of ACCEPTED pushes only — a refused call must not extend the
 * window, or the model could keep the limiter tripped forever by retrying.
 */
class PushRateWindow {
  private readonly accepted: number[] = [];
  private static readonly WINDOW_MS = 60_000;

  private prune(now: number): void {
    const cutoff = now - PushRateWindow.WINDOW_MS;
    while (this.accepted.length > 0 && this.accepted[0]! <= cutoff) this.accepted.shift();
  }

  /** Accepted pushes inside the current window. */
  count(): number {
    this.prune(Date.now());
    return this.accepted.length;
  }

  /** Record one push; false when the window is full (`limit` ≤ 0 = unlimited). */
  accept(limit: number): boolean {
    if (!Number.isFinite(limit) || limit <= 0) return true;
    const now = Date.now();
    this.prune(now);
    if (this.accepted.length >= Math.floor(limit)) return false;
    this.accepted.push(now);
    return true;
  }

  /** Whole seconds until the oldest accepted push leaves the window. */
  retryAfterSeconds(): number {
    this.prune(Date.now());
    const oldest = this.accepted[0];
    if (oldest === undefined) return 0;
    return Math.max(1, Math.ceil((oldest + PushRateWindow.WINDOW_MS - Date.now()) / 1000));
  }
}

export class WeChatDSHBridge {
  private readonly ctx: BridgeContext;
  private config: WeChatDSHConfig;
  private readonly configStore?: ConfigStore;
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
   * Peer id written into `allowedUsers` by the S3 upgrade seeding, until its
   * one-time notice has been delivered (see {@link notifyAllowlistSeed}).
   * Reading it is what makes the notice exactly-once instead of once per
   * inbound message.
   */
  private allowlistSeededPeer: string | null = null;
  /**
   * Latest inbound iLink `context_token` for the peer. Wired into the
   * send payload when present; never used as a send gate.
   */
  private wireContextToken: string | null = null;
  /** Per-run monitor cancellation; recreated on every reconnect. */
  private monitorAbort: AbortController | null = null;
  private monitorRunning = false;
  private monitorTask: Promise<void> | null = null;
  private readonly seenInbound = new Map<string, number>();
  private loginState: LoginState = { phase: "idle" };
  /** Pending question cards per user (rpcId-keyed, first = active). */
  private readonly pendingQuestions = new Map<string, PendingQuestion[]>();
  /** Pending approval cards per user (rpcId-keyed). */
  private readonly pendingApprovals = new Map<string, PendingApproval[]>();
  /**
   * Card rpcIds already pushed to WeChat in full, per user. Prevents a
   * re-send when the user switches into the card's session after it was
   * already delivered (the card is always re-viewable via /history).
   */
  private readonly pushedCardRpcIds = new Map<string, Set<string>>();
  private readonly silentBuffers = new Map<string, string[]>();
  /** Desktop-style process group for the currently bound conversation. */
  private readonly processes = new Map<string, ExecutionProcess>();
  private readonly assistantStreams = new Map<string, {
    attemptId: string; revision: number; turn: number; step: number; lastIndex: number;
    proseStarted: boolean; reasoning: Map<number, string>; handledReasoning: Set<number>;
  }>();
  private readonly streamedReasoning = new Map<string, Set<number>>();
  /** Bounded dedup of committed output records (not transient stream chunks). */
  private readonly seenOutputEvents = new Set<string>();
  /** Invalidates queued sends across logout / re-login, even for the same peer. */
  private outboundGeneration = 0;
  /**
   * 结论模式 (final-only) hold table, keyed by session id. While
   * `config.finalOnly` is on, neither the bound session's assistant text nor
   * a cross-session task notice is pushed as it happens: each is folded into
   * the entry for its session and the whole entry is delivered ONCE, after
   * the task has been quiet for `finalOnlyIdleMs` (or at the
   * `finalOnlyCeilingMs` hard ceiling). This is what collapses a goal that
   * auto-continues over N rounds — each round is a separate DSH turn, so the
   * per-turn `silent` mode still emits one message per round — into a single
   * conclusion.
   */
  private readonly pendingFinal = new Map<string, PendingFinal>();
  /** One global queue and budget: dsh-wechat intentionally serves one peer. */
  private outboundCache: CachedMessage[] = [];
  private wechatMsgCount = 0;
  private cacheNoticeSent = false;
  /** Sliding-window limiter for agent-initiated `send_wechat` pushes. */
  private readonly pushRate = new PushRateWindow();
  /** Reentrancy guard for the cap-pressure force-send in `parkOutbound`. */
  private capFlushActive = false;
  /** Force-sends performed at the cap (log throttle only). */
  private capFlushes = 0;
  /** Serializes all outbound budget/queue mutations across assistant and tool sends. */
  private outboundSerial: Promise<void> = Promise.resolve();
  /**
   * Marks the async call chain of the body currently holding the outbound
   * slot. `AsyncLocalStorage` (rather than a boolean) is what makes the
   * re-entrancy check exact: an unrelated caller that merely ARRIVES while
   * the slot is held is legitimate FIFO queueing, while a call made from
   * INSIDE the held body is the self-deadlock this guards against.
   */
  private readonly outboundChain = new AsyncLocalStorage<true>();
  /** Operations enqueued but not settled — keeps the happy path timer-free. */
  private outboundPending = 0;
  /** Bounded wait for the slot; a test seam, and the R1 escape from a wedged predecessor. */
  private outboundSlotWaitMs = OUTBOUND_SLOT_WAIT_MS;
  /** Append-only audit trail (S4): JSONL under the storage dir, capped + rotated. */
  private readonly audit: AuditLog;
  /** Per-agent model overrides set by `/model switch` / `/reasoning` (applied via agent/request). */
  private readonly modelOverrides = new Map<string, ModelOverride>();
  /** Dedup for cross-session turn/end notifications (userId -> sessionIds already notified this turn). */
  private readonly notifiedCrossSessionTurns = new Map<string, Set<string>>();
  /**
   * Last assistant text per session (for cross-session completion preview).
   * Bounded FIFO at {@link ASSISTANT_PREVIEW_MAX_SESSIONS}: the value is a
   * whole assistant message, so an unbounded map is a real leak on a long
   * lived install with many sessions; eviction only means a completion card
   * loses its quoted tail.
   */
  private readonly lastAssistantTextBySession = new Map<string, string>();
  /**
   * Last user-prompt time per session (from `user/message` events with
   * source.kind === "user" — the same activity the GUI sidebar uses). Used
   * for `/s list` ordering and the time column; sessions without a recorded
   * activity (cold after restart) fall back to their creation time.
   * Bounded FIFO at {@link ACTIVITY_MAX_SESSIONS} (numbers only — the cap
   * exists because every session the process ever sees would otherwise stay
   * resident forever).
   */
  private readonly lastActivityBySession = new Map<string, number>();
  /**
   * Inbound merge window state per WeChat chat (F1). Present only while a
   * batch is open or a dispatch is in flight; deleted once drained, so this
   * map never grows past the number of chats being merged (one peer here).
   */
  private readonly mergedText = new Map<string, MergeState>();
  /**
   * The most recent numbered session list per WeChat user. Keeping the exact
   * ids (rather than only its scope) lets a following shorthand `/s switch
   * <n>` select the row the user actually saw, even if recency changes before
   * the switch arrives. Explicit `/s switch current <n>` bypasses this
   * ephemeral snapshot and resolves the current scope afresh.
   */
  private readonly lastSessionListByUser = new Map<string, {
    scope?: "current";
    cwd: string;
    sessionIds: string[];
  }>();
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
   * messages apart from GUI-typed ones. One-shot consumption with a TTL and a
   * hard cap (see {@link markWechatMessage}).
   */
  private readonly wechatMessageIds = new Map<string, number>();
  /** True after plugin dispose; pending waterfall waiters must not settle to WeChat. */
  private interactionStopped = false;
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

  constructor(
    ctx: BridgeContext,
    config: WeChatDSHConfig,
    commandsCtx?: NativeCommandsSurface | null,
    configStore?: ConfigStore,
  ) {
    this.ctx = ctx;
    this.config = config;
    this.configStore = configStore;
    this.state = new StateStore(config.storageDir);
    this.audit = new AuditLog(config.storageDir, (message) => this.log(message));
    this.migrateSilentFromUsers();
    this.seedAllowlistFromPeer();
    this.restoreOutboundState();
    this.agents = new AgentStore(ctx);
    this.ops = new DshOps(ctx);
    if (commandsCtx) this.commandsCtx = commandsCtx;
  }

  /**
   * Pre-global-silent installs stored the toggle only on the WeChat user.
   * Copy it into config.json once so the settings page and a later re-scan
   * still see the same value.
   */
  private migrateSilentFromUsers(): void {
    if (this.configStore?.stored().silent !== undefined) return;
    if (!this.state.all().some((u) => u.silent)) return;
    this.persistEditable({ silent: true });
  }

  /**
   * S3 — seed the inbound allowlist from the peer this install already
   * belongs to.
   *
   * `allowedUsers` is empty by default, which means "the first inbound user
   * becomes the peer". That is right for a fresh install and WRONG for an
   * install that already has a bound peer: after the upgrade, the first
   * stranger to message the bot would take it over. So when the list has
   * never been configured (`config.json` carries no `allowedUsers` key) and
   * `state.json` already names a peer, the peer is written into the list.
   *
   * Deliberately gated on "never configured": an explicitly stored `[]` is a
   * decision (open to everyone) and is never overwritten. A brand-new install
   * has no peer at all, so it keeps first-contact-wins and can never lock its
   * owner out.
   */
  private seedAllowlistFromPeer(): void {
    if (!this.configStore) return;
    if (this.config.allowedUsers.length > 0) return;
    if (this.configStore.stored().allowedUsers !== undefined) return;
    const peer = this.boundPeerFromState();
    if (!peer) return;
    this.config.allowedUsers = [peer];
    this.persistEditable({ allowedUsers: [peer] });
    this.allowlistSeededPeer = peer;
    this.log(
      `seeded allowedUsers with the already bound peer ${maskUserId(peer)}`
      + " (upgrade hardening: without it the next stranger to message the bot would become the peer)",
    );
  }

  /** The peer an existing install already belongs to, or undefined on a fresh one. */
  private boundPeerFromState(): string | undefined {
    const users = this.state.all();
    // Prefer a user with a real session binding; fall back to the first
    // persisted user (the pre-existing `lockPeerFromState` rule: on a restart
    // the first entry in `state.json` IS the peer) and then to a persisted
    // outbound snapshot, which names the peer too.
    const bound = users.find((u) => typeof u.sessionId === "string" && u.sessionId.length > 0);
    return bound?.userId ?? users[0]?.userId ?? this.state.outbound()?.peerUserId ?? undefined;
  }

  /**
   * Deliver the S3 seeding notice exactly once, to the peer it concerns.
   *
   * Called from the inbound path (and after login), so it needs no timer: the
   * pending flag is cleared only when the message actually left the process,
   * which keeps the "one-shot mark is a commit" rule — a logged-out bot does
   * not burn the notice on a drop.
   */
  private notifyAllowlistSeed(userId: string): void {
    const peer = this.allowlistSeededPeer;
    if (!peer || peer !== userId) return;
    if (!this.botReady() || this.tokenGiveUp) return;
    this.allowlistSeededPeer = null;
    void this.sendReply(
      userId,
      "🔐 升级提示：此前你的微信已是本 bot 的绑定用户，已自动把该账号写入入站白名单（allowedUsers），"
      + "其它微信用户发消息将被忽略。\n"
      + `你的微信 user id：${userId}\n`
      + "查看：/status；修改或清空：DSH 设置 → WeChat → 入站白名单。",
    ).catch((err) => {
      this.log(`allowlist seed notice failed: ${String(err)}`);
    });
  }

  /** Bind or create the WeChat user, inheriting the global silent default. */
  private ensureBoundUser(userId: string): UserState {
    return this.state.ensureUser(userId, this.config.cwd, { silent: this.config.silent });
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

  /**
   * Serialize remote sends with budget and durable queue mutations.
   *
   * Two safety properties, both added after the re-entrancy deadlock that
   * shipped once (a locked body calling a public entry queued itself behind
   * the operation it was awaiting, wedging the WHOLE outbound chain forever):
   *
   *  1. **Re-entrancy assertion.** Entering the slot from inside the async
   *     chain that currently holds it is a programming error, not a queueing
   *     decision. It is detected exactly (via `AsyncLocalStorage`, so a
   *     legitimate concurrent caller that merely arrives while the slot is
   *     held is NOT flagged) and fails LOUDLY and immediately instead of
   *     deadlocking. The fix is always the same: call the `*Locked` variant.
   *  2. **Bounded wait.** A single hung operation must not wedge every later
   *     send: a waiter gives its predecessor {@link OUTBOUND_SLOT_WAIT_MS}
   *     and then proceeds without it, with a loud log. This trades strict
   *     FIFO order — only in the pathological case — for liveness.
   *
   * Happy path is deliberately cheap: when nothing is pending (`outboundPending
   * === 0`) there is no timer, no race and no extra promise hop.
   */
  private serializeOutbound<T>(operation: () => Promise<T>): Promise<T> {
    if (this.outboundChain.getStore() === true) {
      const detail =
        "serializeOutbound re-entered from inside the outbound critical section: "
        + "a locked body must call the *Locked helper, never a public entry "
        + "(this call would queue itself behind the operation it is awaiting and wedge every later send)";
      console.error(`[dsh-wechat] ${detail}`);
      this.audit.record({ event: "outbound-reentry", detail });
      throw new Error(`dsh-wechat internal: ${detail}`);
    }
    const previous = this.outboundSerial;
    const queued = this.outboundPending > 0;
    const run = (async () => {
      if (queued) {
        await this.waitForOutboundSlot(previous);
      } else {
        // Free slot: still defer by one microtask, exactly like the
        // `outboundSerial.then(...)` this replaced. Work enqueued in the same
        // tick must be able to observe state changes that land before the
        // first send starts — e.g. `logout()` bumping `outboundGeneration`
        // right after a `void sendReply(...)`, which is what makes logout
        // discard not-yet-sent payloads.
        await Promise.resolve();
      }
      return this.outboundChain.run(true, () => operation());
    })();
    this.trackOutbound(run);
    return run;
  }

  /** Keep the FIFO tail and the pending counter honest for one enqueued operation. */
  private trackOutbound<T>(run: Promise<T>): void {
    this.outboundPending++;
    const settled = run.then(
      () => { this.outboundPending--; },
      () => { this.outboundPending--; },
    );
    this.outboundSerial = settled;
  }

  /**
   * Wait for the operation currently holding the slot, but never forever.
   * `previous` never rejects (`trackOutbound` maps both outcomes), so the
   * race cannot surface a spurious error into the next operation.
   */
  private async waitForOutboundSlot(previous: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      previous.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.outboundSlotWaitMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      this.log(
        `outbound slot still held after ${this.outboundSlotWaitMs}ms; proceeding WITHOUT it `
        + "(a previous outbound operation appears wedged — liveness beats strict ordering here)",
      );
      this.audit.record({ event: "outbound-slot-timeout", waitMs: this.outboundSlotWaitMs });
    }
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
    if (name === "rq" || name === "rp") return false;
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
    if (name === "rq" || name === "rp") return false;
    // Local whitelist commands (`/s`, `/session`, `/workspace`, …) own
    // their own handlers and must not resume the bound DSH session just
    // to look up a native definition. A corrupt binding would otherwise
    // make `/s new` itself trigger `agents.resume` before the local
    // command can unbind.
    if (LOCAL_COMMAND_NAMES.has(name)) return false;
    // Do not replace a corrupt binding here — a failed resume falls
    // through to `forwardToAgent`, which mints and tells the user.
    const { agent } = await this.agents.ensure(user);
    if (!agent) {
      // Cannot resolve a session to scope `find` against — preserve the
      // existing fall-through behavior (next layer is `forwardToAgent`).
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
      await this.sendReply(userId, `⚠️ 命令执行异常：${maskSecrets(detail)}`);
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
    // /help must not mint a replacement session just to list native
    // commands; a corrupt binding stays put until the user talks or
    // sends `/s new`.
    const { agent } = await this.agents.ensure(user);
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
    for (const key of EDITABLE_KEYS) {
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
        silent: this.isSilent(),
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
    const at = Date.now();
    // One-shot mark + its release timer armed in the SAME block, so "every
    // mark expires" is assertable by construction: the mark is consumed by
    // the `user/message` echo, and an echo that never arrives still releases
    // it here. The cap below is the hard ceiling above that soft TTL — the
    // timer alone cannot bound a burst of messages the agent never claims.
    const timer = setTimeout(() => {
      if (this.wechatMessageIds.get(messageId) === at) this.wechatMessageIds.delete(messageId);
    }, WECHAT_MSG_ID_TTL_MS);
    timer.unref?.();
    this.boundedSet(this.wechatMessageIds, messageId, at, WECHAT_MSG_IDS_MAX, "wechatMessageIds");
  }

  /**
   * Insert into a memo map with a deterministic hard cap: re-inserting moves
   * the key to the tail (so the eviction order is "least recently WRITTEN"),
   * and overflowing drops the head — the oldest entry — with a loud log, the
   * same rule `parkOutbound`'s hard ceiling follows. Every caller of this
   * helper is a cache, never a queue: the evicted value is recomputable or
   * merely cosmetic, which is why the cap may be small.
   */
  private boundedSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number, label: string): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > cap) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
      this.log(`${label}: cap ${cap} reached; evicted oldest entry (a cache, not a queue — nothing is lost)`);
    }
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
   * Plugin dispose: stop the iLink monitor AND abandon pending WeChat
   * waterfall waiters. WeChat reconnect/logout must NOT use this — they
   * only bounce the gateway long-poll (`stopIlink`). Host answerers stay
   * registered for the plugin lifetime and survive QR re-login.
   */
  async stop(): Promise<void> {
    this.stopIlink("plugin-stop");
    // Deliver what 打字合并 is holding BEFORE `stopInteraction()`: the merged
    // batch is forwarded through `forwardToAgent`, which aborts as soon as the
    // interaction is marked stopped — flushing afterwards would silently
    // discard the user's own words. Same rule as the 结论模式 flush below: the
    // peer is not changing, so already-produced input is delivered.
    await this.flushAllMergedText("dispose");
    this.stopInteraction();
    this.processes.clear();
    this.assistantStreams.clear();
    this.streamedReasoning.clear();
    this.silentBuffers.clear();
    this.seenOutputEvents.clear();
    this.outboundGeneration++;
    // A hold is a conclusion the agent ALREADY produced. Plugin dispose /
    // host shutdown is not a rebind: the peer is still the same WeChat user
    // and the answer is still wanted, so it is delivered rather than
    // destroyed. This runs BEFORE `monitorTask` is awaited, while the token
    // and the gateway cursors are still live.
    //
    // The contrast is `resetPeerBinding()` / `discardQueuedOutbound()`
    // (logout, re-login, peer re-bind): there the identity is changing, so a
    // held conclusion belongs to a peer we no longer serve and must NOT be
    // delivered to whoever binds next.
    //
    // `flushPendingFinal` already swallows a send failure per session, so a
    // broken gateway cannot turn dispose into a rejection.
    await this.flushAllPendingFinal("dispose");
    await this.monitorTask;
    // Release the audit descriptor last: everything above can still record.
    this.audit.close();
  }

  /** Stop the WeChat long-poll and typing indicators; leave Host answerers running. */
  private stopIlink(typingReason: string): void {
    this.monitorAbort?.abort();
    this.monitorAbort = null;
    this.monitorRunning = false;
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
    this.seenInbound.clear();
    this.wireContextToken = null;
    this.typingTickets.clear();
    this.pendingQuestions.clear();
    this.pendingApprovals.clear();
    this.pushedCardRpcIds.clear();
    this.notifiedCrossSessionTurns.clear();
    // Identity change: a half-typed batch belongs to the peer we no longer
    // serve and must never be handed to whoever binds next.
    this.dropMergedText();
    this.discardPendingFinal();
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
    this.outboundGeneration++;
    this.processes.clear();
    this.assistantStreams.clear();
    this.streamedReasoning.clear();
    this.seenOutputEvents.clear();
    const parked = this.outboundCache.length;
    this.outboundCache = [];
    this.cacheNoticeSent = false;
    this.wechatMsgCount = 0;
    this.silentBuffers.clear();
    this.dropMergedText();
    this.discardPendingFinal();
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
    if (this.monitorRunning || !this.token || this.interactionStopped) return;
    // Reconnect must wait for the cancelled run to finish. Check again after
    // awaiting: another caller may already have started the replacement.
    await this.monitorTask;
    if (this.monitorRunning || !this.token || this.interactionStopped) return;
    this.monitorRunning = true;
    const abort = new AbortController();
    this.monitorAbort = abort;
    const task = startMonitor({
      baseUrl: this.token.baseUrl,
      token: this.token.token,
      storageDir: this.config.storageDir,
      abortSignal: abort.signal,
      log: (msg) => console.log(`[dsh-wechat] ${msg}`),
      onMessage: (msg) => {
        if (abort.signal.aborted || this.monitorAbort !== abort || this.interactionStopped) return;
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
        if (this.monitorAbort === abort) {
          this.monitorRunning = false;
          this.monitorAbort = null;
        }
        if (this.monitorTask === task) this.monitorTask = null;
      });
    this.monitorTask = task;
  }

  // ─── Config updates (from the settings page) ───

  /**
   * Apply a config patch. Returns the updated editable values. When the
   * gateway connection fields change while logged in, the monitor is
   * restarted automatically.
   */
  async updateConfig(patch: Partial<EditableConfig>): Promise<{ config: Record<string, unknown>; message: string }> {
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

    if (typeof patch.silent === "boolean") {
      if (patch.silent !== before.silent) {
        this.processes.clear();
        this.assistantStreams.clear();
        this.streamedReasoning.clear();
        if (!patch.silent) this.silentBuffers.clear();
      }
      for (const user of this.state.all()) {
        this.state.update(user.userId, { silent: patch.silent });
      }
    }

    // Turning 打字合并 off from the settings page must not swallow whatever
    // the window was holding: those are the user's own words.
    if (patch.mergeEnabled === false) {
      await this.flushAllMergedText("config-merge-off");
    }

    const editable: Record<string, unknown> = {};
    for (const key of EDITABLE_KEYS) {
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
    if (typeof patch.silent === "boolean") {
      this.persistEditable({ silent: patch.silent });
      toUpdate.silent = patch.silent;
    }
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

  private inboundKey(msg: WeixinMessage): string | undefined {
    const identity = typeof msg.message_id === "number" && Number.isSafeInteger(msg.message_id) && msg.message_id > 0
      ? `m:${msg.message_id}`
      : typeof msg.seq === "number" && Number.isSafeInteger(msg.seq) && msg.seq > 0 ? `s:${msg.seq}` : undefined;
    return identity ? JSON.stringify([msg.from_user_id, identity]) : undefined;
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    if (this.interactionStopped || msg.message_type !== MessageType.USER || msg.group_id || !msg.from_user_id) return;
    // Inbound allowlist, BEFORE dedupe, budget reset, session creation and any
    // command handling: a rejected sender must not consume a dedupe slot, a
    // session, or an agent turn. An empty list is the historical behaviour
    // (first inbound user becomes the peer), so this is opt-in only.
    const allowed = this.config.allowedUsers;
    if (allowed.length > 0 && !allowed.some((id) => id === msg.from_user_id)) {
      // Logged, never answered: replying would confirm the bot is live to an
      // unknown sender and spend a gateway message doing it. Both the log line
      // and the audit record carry the MASKED id (S4).
      this.log(`ignore inbound from ${maskUserId(msg.from_user_id)}: not in allowedUsers`);
      this.audit.record({
        event: "inbound-rejected",
        user: maskUserId(msg.from_user_id),
        reason: "allowedUsers",
      });
      return;
    }
    if (this.peerUserId && this.peerUserId !== msg.from_user_id) return;
    const key = this.inboundKey(msg);
    const now = Date.now();
    for (const [seenKey, at] of this.seenInbound) {
      if (now - at < INBOUND_TTL_MS) break;
      this.seenInbound.delete(seenKey);
    }
    if (key) {
      if (this.seenInbound.has(key)) return;
      // Reserve synchronously, before the first await, so concurrent replays
      // cannot execute commands, reset the send budget, or create agents twice.
      this.seenInbound.set(key, now);
      if (this.seenInbound.size > INBOUND_MAX_SEEN) {
        this.seenInbound.delete(this.seenInbound.keys().next().value!);
      }
    }
    try {
      await this.processMessage(msg);
    } catch (err) {
      if (key && this.seenInbound.get(key) === now) this.seenInbound.delete(key);
      throw err;
    }
  }

  private async processMessage(msg: WeixinMessage): Promise<void> {
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

    const user = this.ensureBoundUser(userId);
    this.persistOutboundState(userId);
    // S3 one-time notice: the allowlist was seeded on upgrade, and the peer
    // should learn about it exactly once (see `notifyAllowlistSeed`).
    this.notifyAllowlistSeed(userId);

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

    // Answerable cards: current session always; other sessions only while
    // the decision gate is on. A lone background card must not swallow a
    // bare reply — those need `P{n}=`. `/rq` closes current-session cards;
    // `P1=/rq` closes that numbered card (question or approval).
    const approvals = this.answerableApprovals(userId);
    const questions = this.answerableQuestions(userId);
    const current = this.pendingCardsForCurrentSession(userId);
    const pn = text ? parsePnCardReply(text) : null;
    const isClose = text !== null && text !== "" && this.isCardCloseCommand(text);

    if (!bypassCard && isClose) {
      await this.rejectCurrentSessionCards(userId);
      return;
    }
    if (!bypassCard && pn !== null && text) {
      await this.handlePnReplies(userId, text);
      return;
    }

    if (!bypassCard && approvals.length > 0 && (pn !== null || current.approvals.length > 0)) {
      if (text === null || text === "") {
        await this.sendReply(userId, `⚠️ 当前有权限卡待处理。回复 1（允许一次）/ 2（拒绝）；其它会话用 P1=1；关闭用 /rq（当前会话）或 P1=/rq。`);
        return;
      }
      await this.handleApprovalReply(userId, text);
      return;
    }

    if (!bypassCard && questions.length > 0 && current.questions.length > 0) {
      if (text === null || text === "") {
        await this.sendReply(userId, `⚠️ 当前有提问卡待处理。当前会话直接回复；其它会话用 P1=…；关闭用 /rq（当前会话）或 P1=/rq。`);
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

    this.log(`Message from ${maskUserId(userId)}: ${maskSecrets(this.previewMessage(msg))}`);
    // S4 audit: masked sender + SIZE only — never the body. Recorded after the
    // dedupe gate, so a replayed duplicate is not a second inbound event.
    this.audit.record({
      event: "inbound",
      user: maskUserId(userId),
      chars: text.length,
      items: (msg.item_list ?? []).length,
    });

    if (text) {
      // One audit line per slash command (name only — never its arguments,
      // which can carry a path, a preset name or an answer).
      if (text.trim().startsWith("/")) {
        const name = parseCommandName(text) ?? text.trim().split(/\s+/)[0]!.slice(0, 32);
        this.audit.record({ event: "command", user: maskUserId(userId), command: name });
      }
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

      const finalCmd = parseFinalCommand(text);
      if (finalCmd) {
        await this.handleFinalCommand(userId, finalCmd);
        return;
      }

      const mergeCmd = parseMergeCommand(text);
      if (mergeCmd) {
        await this.handleMergeCommand(userId, mergeCmd);
        return;
      }

      if (parseFlushCommand(text)) {
        const flushed = await this.flushAllPendingFinal("command");
        await this.sendReply(
          userId,
          flushed > 0
            ? `📤 已立即取回 ${flushed} 条暂存的最终结论。`
            : "📭 当前没有暂存的结论（结论模式未开启，或已交付）。",
        );
        return;
      }

      const surface = parseSurfaceCommand(text);
      if (surface) {
        await this.handleSurfaceCommand(userId, surface);
        return;
      }

      const notifyCmd = parseNotifyCommand(text);
      if (notifyCmd) {
        await this.handleNotifyCommand(userId, notifyCmd);
        return;
      }

      const status = parseStatusCommand(text);
      if (status) {
        await this.sendReply(userId, await this.formatStatus(user), { parkOnError: false });
        return;
      }

      const stop = parseStopCommand(text);
      if (stop) {
        await this.handleStopCommand(userId, user);
        return;
      }

      const rq = parseRejectQuestionCommand(text);
      if (rq) {
        await this.rejectCurrentSessionCards(userId);
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
        await this.sendReply(
          userId,
          `⚠️ 用法: /history [all] [数量]（1-${HISTORY_MAX}，默认 5）例如 /history 10 或 /history all`,
        );
        return;
      }

      // Unrecognized slash command — hint, then forward to the agent.
      const slashHint = detectUnknownSlashCommand(text);
      if (slashHint) {
        await this.sendReply(userId, `⚠️ 未知命令 ${slashHint}，已作为文本转发给 agent。发送 /help 查看可用命令。`);
      }
    }

    await this.enqueueInbound(user, msg);
  }

  private persistSessionBinding(user: UserState): void {
    this.state.update(user.userId, { sessionId: user.sessionId });
    this.trackWatchedSession(user.userId, user.sessionId);
  }

  private async forwardToAgent(user: UserState, msg: WeixinMessage): Promise<void> {
    const previousSessionId = user.sessionId;
    const { agent, replacedSessionId } = await this.agents.ensure(user, { replaceOnResumeFailure: true });
    if (this.interactionStopped) return;
    this.persistSessionBinding(user);
    if (!agent) {
      const hint = previousSessionId
        ? `（绑定会话 ${previousSessionId} 无法恢复）`
        : "";
      await this.sendReply(user.userId, `⚠️ 无法创建/恢复 DSH 会话${hint}，请检查 DSH 日志。`);
      return;
    }
    if (replacedSessionId) {
      await this.sendReply(
        user.userId,
        `⚠️ 原会话 ${replacedSessionId} 已损坏，无法恢复；已新建会话 ${user.sessionId}。`,
      );
    }

    const tempDir = path.join(this.config.storageDir, "tempfile");
    const blocks = await weixinMessageToPrompt(msg, this.config.cdnBaseUrl, (m) => this.log(m), tempDir);
    if (this.interactionStopped) return;
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
    this.agents.followup(agent, blocks, mode, (id) => this.markWechatMessage(id));
  }

  // ─── Inbound merge window (F1, 打字合并) ───
  //
  // One thought typed as five WeChat messages used to cost five turns. Bare
  // text now enters a per-chat buffer that is delivered as ONE prompt when the
  // silence window elapses or the message cap is reached. The rules that keep
  // this from becoming a trap:
  //
  //   - an OUT-OF-ORDER older message never extends the silence timer (a late
  //     replay must not hold a batch open while the user waits);
  //   - the buffered count has a defensive hard cap (`mergeMaxMsgs`);
  //   - a FORCED RELEASE (`mergeForcedReleaseMs`, default 3 min) dispatches the
  //     batch no matter what — "rather two messages in one turn than a
  //     permanently blocked channel";
  //   - a message that arrives while a previous batch is in flight starts a
  //     NEW batch that waits for the in-flight one only up to that same bound,
  //     so it is never silently swallowed;
  //   - non-text items (image / file / video / voice-without-transcript) are
  //     NEVER merged: they first flush the pending text as its own turn, then
  //     go to the agent as their own turn, which preserves the order the user
  //     typed and keeps a media attachment out of a text batch.
  //
  // Toggle from WeChat with `/merge on|off|status`; parameter defaults live in
  // `config.ts`. `mergeSilenceMs: 0` (or `/merge off`) restores one-turn-per-
  // message exactly.

  private mergeEnabled(): boolean {
    return this.config.mergeEnabled === true;
  }

  private mergeSilenceMs(): number {
    const value = this.config.mergeSilenceMs;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 3000;
  }

  private mergeMaxMsgs(): number {
    const value = this.config.mergeMaxMsgs;
    // `Math.max(1, …)`: a fractional value must still leave a usable cap —
    // flooring 0.5 to 0 would flush on every single message.
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.max(1, Math.floor(value))
      : 10;
  }

  private mergeForcedReleaseMs(): number {
    const value = this.config.mergeForcedReleaseMs;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 3 * 60_000;
  }

  /** Entry point for every inbound item: decide merge vs. immediate turn. */
  private async enqueueInbound(user: UserState, msg: WeixinMessage): Promise<void> {
    const text = extractText(msg.item_list);
    const items = msg.item_list ?? [];
    const hasMedia = items.some((item) => item.type !== undefined && item.type !== MessageItemType.TEXT);
    if (!this.mergeEnabled() || this.mergeSilenceMs() <= 0 || !text || hasMedia) {
      if (hasMedia && this.mergedText.has(user.userId)) {
        // Deliver what was typed BEFORE the media item first: a batch that
        // swallowed it and then handed over the image would reorder the
        // conversation for the agent.
        await this.flushMergedText(user.userId, "media");
      }
      await this.forwardToAgent(user, msg);
      return;
    }

    // Suffix tokens. `!!` commits now, `..` keeps the batch open. Both are
    // stripped from the text. A message that is ONLY the token acts as pure
    // control when there is something to control (a bare `!!` commits the
    // pending batch without polluting it) and stays literal text otherwise —
    // a trailing token must never make the message disappear.
    const state = this.mergeStateFor(user.userId);
    const buffered = state.entries.length;
    let body = text;
    let commitNow = false;
    let holdOpen = false;
    if (this.config.mergeSuffixTokens === true) {
      const trimmed = text.replace(/\s+$/, "");
      const stripped = trimmed.slice(0, -2).trim();
      const commitToken = trimmed.endsWith("!!") && (stripped.length > 0 || buffered > 0);
      const holdToken = !commitToken && trimmed.endsWith("..") && (stripped.length > 0 || buffered > 0);
      if (commitToken) {
        commitNow = true;
        body = stripped;
      } else if (holdToken) {
        holdOpen = true;
        body = stripped;
      }
    }

    const now = Date.now();
    const sourceAt = typeof msg.create_time_ms === "number" && Number.isFinite(msg.create_time_ms)
      ? msg.create_time_ms
      : now;
    const newer = state.entries.length === 0 || sourceAt >= state.newestSourceAt;
    if (body.length > 0) {
      state.entries.push(body);
      if (newer) state.newestSourceAt = sourceAt;
    }
    if (!state.ceiling) state.ceiling = this.armMergeTimer(state, this.mergeForcedReleaseMs(), "forced-release");

    if (state.entries.length >= this.mergeMaxMsgs()) {
      await this.flushMergedText(user.userId, "cap");
      return;
    }
    if (commitNow) {
      await this.flushMergedText(user.userId, "suffix-commit");
      return;
    }
    if (holdOpen) {
      // `..` = "I am not done": no silence flush; the cap, a later `!!`, a
      // media message or the forced release still deliver the batch.
      state.holdOpen = true;
      if (state.silence) {
        clearTimeout(state.silence);
        state.silence = undefined;
      }
      this.log(`merge: batch for ${maskUserId(user.userId)} held open by '..' (${state.entries.length} msg)`);
      return;
    }
    if (state.holdOpen) {
      // Still inside an explicit `..` hold: appending is all this message does.
      return;
    }
    // Only a message that is not older than everything buffered re-arms the
    // silence window (the out-of-order guard).
    if (newer) {
      if (state.silence) clearTimeout(state.silence);
      state.silence = this.armMergeTimer(state, this.mergeSilenceMs(), "silence");
    } else {
      this.log(`merge: ignoring out-of-order older message for ${maskUserId(user.userId)} (silence timer not extended)`);
    }
  }

  private mergeStateFor(userId: string): MergeState {
    let state = this.mergedText.get(userId);
    if (!state) {
      state = {
        userId,
        entries: [],
        newestSourceAt: 0,
        firstAt: Date.now(),
        holdOpen: false,
        inFlight: null,
      };
      this.mergedText.set(userId, state);
    }
    return state;
  }

  /** Arm one batch timer; both timers are cleared on every flush path. */
  private armMergeTimer(state: MergeState, ms: number, reason: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.flushMergedText(state.userId, reason).catch((err) => {
        this.log(`merge flush (${reason}) failed for ${maskUserId(state.userId)}: ${String(err)}`);
      });
    }, ms);
    timer.unref?.();
    return timer;
  }

  /**
   * Deliver the chat's buffered text as ONE prompt.
   *
   * Ordering: a batch that arrives while the previous one is still being
   * dispatched waits for it — but only up to `mergeForcedReleaseMs`, after
   * which it logs and dispatches anyway. Waiting is about preserving the
   * user's message order; it is never allowed to become a stuck channel.
   */
  private async flushMergedText(userId: string, reason: string): Promise<void> {
    const state = this.mergedText.get(userId);
    if (!state || state.entries.length === 0) return;
    const entries = state.entries.splice(0, state.entries.length);
    state.holdOpen = false;
    if (state.silence) {
      clearTimeout(state.silence);
      state.silence = undefined;
    }
    if (state.ceiling) {
      clearTimeout(state.ceiling);
      state.ceiling = undefined;
    }
    state.newestSourceAt = 0;
    const user = this.state.getUser(userId);
    if (!user) {
      this.log(`merge: dropping ${entries.length} buffered message(s) for unknown user ${maskUserId(userId)}`);
      this.dropMergedText(userId);
      return;
    }
    const text = entries.join("\n");
    const merged: WeixinMessage = {
      message_type: MessageType.USER,
      from_user_id: userId,
      ...(this.wireContextToken ? { context_token: this.wireContextToken } : {}),
      item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
    };
    this.log(
      `merge flush (${reason}): ${entries.length} message(s), ${text.length} chars for ${maskUserId(userId)}`,
    );
    const previous = state.inFlight;
    const run = (async () => {
      if (previous) {
        let timer: NodeJS.Timeout | undefined;
        const timedOut = await Promise.race([
          previous.then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), this.mergeForcedReleaseMs());
            timer.unref?.();
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (timedOut) {
          this.log(
            `merge: previous batch for ${maskUserId(userId)} still in flight after `
            + `${this.mergeForcedReleaseMs()}ms; dispatching anyway (a blocked channel is worse than two turns)`,
          );
        }
      }
      await this.forwardToAgent(user, merged);
    })();
    const tracked = run.then(
      () => undefined,
      (err) => {
        this.log(`merge dispatch failed for ${maskUserId(userId)}: ${String(err)}`);
      },
    );
    state.inFlight = tracked;
    await tracked;
    if (state.inFlight === tracked) state.inFlight = null;
    if (state.entries.length === 0 && state.inFlight === null) this.mergedText.delete(userId);
  }

  /** Deliver every open batch (plugin dispose — the user's own words are not destroyed). */
  private async flushAllMergedText(reason: string): Promise<void> {
    for (const userId of [...this.mergedText.keys()]) {
      try {
        await this.flushMergedText(userId, reason);
      } catch (err) {
        this.log(`merge flush-all failed for ${maskUserId(userId)}: ${String(err)}`);
      }
    }
  }

  /** Drop a chat's buffer and timers (identity change: logout / re-login / re-bind). */
  private dropMergedText(userId?: string): void {
    const targets = userId === undefined ? [...this.mergedText.keys()] : [userId];
    for (const key of targets) {
      const state = this.mergedText.get(key);
      if (!state) continue;
      if (state.silence) clearTimeout(state.silence);
      if (state.ceiling) clearTimeout(state.ceiling);
      this.mergedText.delete(key);
    }
  }

  /** Human-readable merge state for `/merge status` and `/status` (never write-only state). */
  private mergeStatusText(): string {
    if (!this.mergeEnabled()) return "off（每条消息各自一轮）";
    const pending = this.pendingMergedCount();
    const window = this.mergeSilenceMs();
    if (window <= 0) return "on（窗口 0ms = 立即转发）";
    // How long the oldest open batch has been waiting: the window is otherwise
    // invisible until it fires, which makes "why is nothing happening?" hard
    // to answer from WeChat alone.
    const open = [...this.mergedText.values()].find((state) => state.entries.length > 0);
    const openFor = open ? Math.round((Date.now() - open.firstAt) / 1000) : undefined;
    return `on（静默 ${(window / 1000).toFixed(1)}s / 上限 ${this.mergeMaxMsgs()} 条 / 强制放行 ${Math.round(this.mergeForcedReleaseMs() / 1000)}s${pending > 0 ? ` / 暂存 ${pending} 条（已等 ${openFor}s）` : ""}）`;
  }

  /** Buffered (not yet dispatched) inbound message count across chats. */
  private pendingMergedCount(): number {
    let total = 0;
    for (const state of this.mergedText.values()) total += state.entries.length;
    return total;
  }

  // ─── Outbound: DSH → WeChat ───

  /**
   * Handle one session event for a WeChat-bound session.
   * Assistant prose stays separate; reasoning and tool events accumulate in
   * one process group until prose, a decision card, or turn/end.
   * Silent mode buffers only the last assistant prose.
   * (Approval/question cards are frame-driven via handleMuxFrame, not
   * session events — this listener only carries agent output.)
   *
   * NOTE: SessionEvent is the wrapped `{ type, seq, time, data }` shape —
   * the message lives in `event.data.message`, NOT at the top level.
   */
  handleSessionEvent(sessionId: string, event: { type: string; [k: string]: unknown }): void {
    if (this.interactionStopped) return;
    if (["assistant/message", "tool/call", "tool/result", "turn/start", "turn/end"].includes(event.type)
      && typeof event.seq === "number" && Number.isSafeInteger(event.seq) && event.seq >= 0) {
      const key = JSON.stringify([sessionId, event.seq]);
      if (this.seenOutputEvents.has(key)) return;
      this.seenOutputEvents.add(key);
      if (this.seenOutputEvents.size > 256) this.seenOutputEvents.delete(this.seenOutputEvents.values().next().value!);
    }
    // Mark the message source BEFORE the agent assembles its prompt.
    // Agent followups (WeChat AND GUI) go through `inbox.append` →
    // `session.append('agent/inbox/spliced')` — this event is emitted at
    // ENQUEUE time, i.e. before the agent claims the message and assembles
    // the system prompt (preStep). WeChat-injected messages are those
    // whose id is in `wechatMessageIds`; anything else in a next-turn splice is a GUI
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
            (m) => typeof m?.id === "string" && this.wechatMessageIds.has(m.id),
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
        this.boundedSet(
          this.lastActivityBySession,
          sessionId,
          typeof event.time === "number" ? event.time : Date.now(),
          ACTIVITY_MAX_SESSIONS,
          "lastActivityBySession",
        );
        // Fallback source marking (the authoritative one happens on
        // agent/inbox/spliced above; this echo is emitted AFTER assembly,
        // so it only corrects sessions whose splice event was missed).
        const id = typeof data.id === "string" ? data.id : undefined;
        const isWechatEcho = id !== undefined && this.wechatMessageIds.has(id);
        if (isWechatEcho) {
          this.markSessionSource(sessionId, "wechat");
          this.wechatMessageIds.delete(id);
        } else {
          this.markSessionSource(sessionId, "gui");
        }
      }
    }

    // The delivery decision below reads `source.kind` inline: `goal`,
    // `subagent-settled` and `tool-jobs` are automatic (keep holding), while a
    // human prompt is `{kind:'user'}` and must release whatever is still held —
    // it belongs to the PREVIOUS request.
    if (event.type === "user/message") {
      const source = (event.data as { source?: { kind?: string } })?.source;
      if (source?.kind === "user") {
        // The user is speaking again: whatever is still held belongs to the
        // PREVIOUS request, so deliver it before the new task starts holding.
        if (this.finalOnlyEnabled() && this.pendingFinal.has(sessionId)) {
          void this.flushPendingFinal(sessionId, "new-user-message");
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
      if (text) {
        this.boundedSet(
          this.lastAssistantTextBySession,
          sessionId,
          text,
          ASSISTANT_PREVIEW_MAX_SESSIONS,
          "lastAssistantTextBySession",
        );
      }
    }

    const user = this.userForAgent(sessionId);
    if (!user) {
      this.clearSessionOutput(sessionId);
      if (event.type === "turn/end") {
        void this.notifyCrossSessionTurnEnd(sessionId);
      }
      return;
    }

    if (event.type === "turn/end") {
      void (async () => {
        // Task completion notices follow their own gate (notifyTaskEvents);
        // the decision-card gate no longer covers them.
        if (!this.notifyTaskEventsEnabled()) return;
        const recipients = await this.resolveCrossSessionRecipients(sessionId);
        for (const r of recipients) {
          if (r.userId === user.userId) continue;
          if (!this.notifyTaskEventsEnabled()) continue;
          const ctx = await this.sessionContextLabel(sessionId);
          const suffix = this.previewSuffix(sessionId);
          const body = ctx + "\n✅ 任务已完成" + suffix + "\n发送 /session switch <编号> 切换查看。";
          const holdMode = this.finalOnlyEnabled();
          // The immediate path must confirm reachability BEFORE claiming the
          // dedupe slot: marking while unreachable and then bailing out would
          // both suppress a later, deliverable completion of the same session
          // and (as originally written) leave the mark with no cleanup timer.
          // The hold path is exempt — a held conclusion is flushed through
          // `sendReply`, so parking it while offline is exactly what makes it
          // survive.
          if (!holdMode && !this.botReady()) continue;
          const set = this.notifiedCrossSessionTurns.get(r.userId) ?? new Set<string>();
          if (set.has(sessionId)) continue;
          set.add(sessionId);
          this.notifiedCrossSessionTurns.set(r.userId, set);
          // Arm the cleanup for every path that marks, so a mark can never
          // outlive its 30s window without a timer to release it.
          setTimeout(() => this.notifiedCrossSessionTurns.get(r.userId)?.delete(sessionId), 30_000);
          // 结论模式: fold this round's completion card into the task's hold
          // instead of emitting one card per auto-continued round.
          if (holdMode) {
            this.foldFinalRound(sessionId);
            this.holdFinalNotice(r.userId, sessionId, body);
            continue;
          }
          void this.sendReply(r.userId, body).catch(() => {});
        }
      })();
    }

    if (this.isSilent() || !this.token || this.tokenGiveUp) this.processes.delete(sessionId);
    switch (event.type) {
      case "turn/start":
        this.clearSessionOutput(sessionId);
        break;
      case "assistant/message": {
        const data = event.data as { turn?: number; step?: number; message?: { content?: OutputContentBlock[] } };
        const blocks = data?.message?.content ?? [];
        const activeStream = this.assistantStreams.get(sessionId);
        const stream = activeStream?.turn === data?.turn && activeStream?.step === data?.step ? activeStream : undefined;
        const streamKey = JSON.stringify([sessionId, event.seq]);
        const handledReasoning = this.streamedReasoning.get(streamKey) ?? stream?.handledReasoning;
        this.streamedReasoning.delete(streamKey);
        if (this.isSilent()) {
          const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text).join("\n");
          if (text.trim()) this.silentBuffers.set(sessionId, [text]);
          break;
        }
        // Keep adjacent prose blocks together, flushing the process group BEFORE prose.
        let prose: string[] = [];
        const sendProse = () => {
          if (!prose.length) return;
          this.flushProcess(sessionId, user.userId);
          const proseText = prose.join("\n");
          prose = [];
          // 结论模式 (per-task) outranks 静默 (per-turn): hold the exact text
          // this turn would otherwise push and let the quiescence timer deliver
          // the conclusion once the whole task — every auto-continued round
          // included — has stopped. The typing indicator stays on through the
          // whole turn: agent.status is still "running" while text is produced,
          // and it is only cancelled on turn/end / agent/error / plugin stop.
          if (this.holdFinalText(user.userId, sessionId, proseText)) return;
          this.pushOutput(user.userId, proseText);
        };
        for (const [blockIndex, block] of blocks.entries()) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            prose.push(block.text);
          } else if (block.type === "reasoning") {
            sendProse();
            if (!handledReasoning?.has(blockIndex)) this.processFor(sessionId)?.addReasoning(block);
          }
          // Calls are handled only by tool/call, never by assistant tool blocks.
        }
        sendProse();
        break;
      }
      case "tool/call": {
        const data = event.data as ToolCallData;
        if (data?.callId && data.name) this.processFor(sessionId)?.addCall(data.callId, data.name, data.arguments ?? "");
        break;
      }
      case "tool/result": {
        const data = event.data as ToolResultData;
        if (data?.message) this.processFor(sessionId)?.addResult(data);
        break;
      }
      case "turn/end": {
        this.flushProcess(sessionId, user.userId);
        const buffer = this.silentBuffers.get(sessionId);
        if (this.finalOnlyEnabled()) {
          // Whatever the per-turn buffer still held belongs to this task's
          // conclusion; fold it in and count the round.
          if (buffer && buffer.length > 0) {
            this.silentBuffers.delete(sessionId);
            this.holdFinalText(user.userId, sessionId, buffer[buffer.length - 1]!);
          }
          this.foldFinalRound(sessionId);
          // A turn boundary is activity too: restart the countdown so a turn
          // whose tail ran longer than the idle window still settles cleanly.
          const held = this.pendingFinal.get(sessionId);
          if (held) this.armFinalSettle(held);
          this.clearSessionOutput(sessionId);
          this.clearCrossSessionTurnNotified(user.userId, sessionId);
          // Turn finished → agent.status flips back to "idle". Always clear
          // the typing indicator here, regardless of whether any text was
          // produced.
          this.endTyping(user.userId, "turn-end");
          break;
        }
        if (this.isSilent() && buffer?.length) this.pushOutput(user.userId, buffer[buffer.length - 1]!);
        this.clearSessionOutput(sessionId);
        this.endTyping(user.userId, "turn-end");
        this.clearCrossSessionTurnNotified(user.userId, sessionId);
        break;
      }
    }
  }

  // ─── 结论模式 / Final-only hold (per-TASK, not per-turn) ───
  //
  // `silent` collapses the intermediate steps *within* one turn; it still
  // emits one message per turn, so a goal that auto-continues over N rounds
  // (each round is its own DSH turn, woken by the round driver on
  // `agent/status → idle`) still produces N messages. `finalOnly` instead
  // holds every push — the bound session's assistant text AND the
  // cross-session "✅ 任务已完成" notices — and delivers exactly one
  // consolidated conclusion once the whole task has gone quiet.

  /** Whether 结论模式 (per-task hold) is on. Supersedes `silent`. */
  private finalOnlyEnabled(): boolean {
    return this.config.finalOnly === true;
  }

  private finalOnlyIdleMs(): number {
    const value = this.config.finalOnlyIdleMs;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 45_000;
  }

  private finalOnlyCeilingMs(): number {
    const value = this.config.finalOnlyCeilingMs;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 10 * 60_000;
  }

  private ensurePendingFinal(sessionId: string, userId: string): PendingFinal {
    const existing = this.pendingFinal.get(sessionId);
    if (existing) return existing;
    const now = Date.now();
    const entry: PendingFinal = {
      sessionId,
      userId,
      body: "",
      notice: "",
      rounds: 0,
      firstAt: now,
      lastAt: now,
    };
    this.pendingFinal.set(sessionId, entry);
    // The ceiling is measured from the FIRST hold and is never re-armed, so a
    // task that never goes quiet still reports in at least once per window.
    entry.ceiling = setTimeout(
      () => void this.flushPendingFinal(sessionId, "ceiling"),
      this.finalOnlyCeilingMs(),
    );
    entry.ceiling.unref?.();
    return entry;
  }

  /** (Re)arm the quiescence timer: every activity event pushes delivery back. */
  private armFinalSettle(entry: PendingFinal): void {
    if (entry.settle) clearTimeout(entry.settle);
    const remaining = entry.firstAt + this.finalOnlyCeilingMs() - Date.now();
    const delay = Math.max(0, Math.min(this.finalOnlyIdleMs(), remaining));
    entry.settle = setTimeout(() => void this.flushPendingFinal(entry.sessionId, "idle"), delay);
    entry.settle.unref?.();
  }

  /** A turn started (or a new round was queued): stop the countdown. */
  private cancelFinalSettle(sessionId: string): void {
    const entry = this.pendingFinal.get(sessionId);
    if (entry?.settle) {
      clearTimeout(entry.settle);
      entry.settle = undefined;
    }
  }

  /**
   * Hold one assistant text. Returns true when the caller must NOT deliver it
   * now (the hold owns delivery from here on).
   */
  private holdFinalText(userId: string, sessionId: string, text: string): boolean {
    if (!this.finalOnlyEnabled()) return false;
    const entry = this.ensurePendingFinal(sessionId, userId);
    entry.userId = userId;
    entry.body = text;
    entry.lastAt = Date.now();
    this.armFinalSettle(entry);
    return true;
  }

  /**
   * Fold a cross-session completion notice into the hold. A real assistant
   * body always wins over the 80-char preview, so a bound session keeps its
   * full conclusion while an unbound one still collapses to one message.
   */
  private holdFinalNotice(userId: string, sessionId: string, notice: string): void {
    const entry = this.ensurePendingFinal(sessionId, userId);
    entry.userId = userId;
    if (!entry.body) entry.notice = notice;
    entry.lastAt = Date.now();
    this.armFinalSettle(entry);
  }

  /** Count a finished turn into the hold's round tally (for the digest header). */
  private foldFinalRound(sessionId: string): void {
    const entry = this.pendingFinal.get(sessionId);
    if (entry) entry.rounds += 1;
  }

  /** True when this session currently has something held back. */
  hasPendingFinal(sessionId: string): boolean {
    return this.pendingFinal.has(sessionId);
  }

  /**
   * Deliver the held conclusion for one session, if any. Delivery goes
   * through `sendReply`, so chunking, the outbound budget and the offline
   * park/queue behaviour are exactly the same as a normal reply.
   */
  private async flushPendingFinal(sessionId: string, reason: string): Promise<void> {
    const entry = this.pendingFinal.get(sessionId);
    if (!entry) return;
    this.pendingFinal.delete(sessionId);
    if (entry.settle) clearTimeout(entry.settle);
    if (entry.ceiling) clearTimeout(entry.ceiling);
    const text = entry.body || entry.notice;
    if (!text) return;
    const digest = entry.body && entry.rounds > 1
      ? `✅ 已完成（共 ${entry.rounds} 轮）\n${text}`
      : text;
    this.log(`final-only flush ${sessionId} (${reason}, ${entry.rounds} round(s))`);
    await this.sendReply(entry.userId, digest).catch((err) => {
      this.log(`final-only flush failed: ${String(err)}`);
    });
  }

  /** Deliver everything currently held (the `/flush` escape hatch). */
  private async flushAllPendingFinal(reason: string): Promise<number> {
    const sessionIds = [...this.pendingFinal.values()]
      .sort((a, b) => a.lastAt - b.lastAt)
      .map((entry) => entry.sessionId);
    for (const sessionId of sessionIds) {
      await this.flushPendingFinal(sessionId, reason);
    }
    return sessionIds.length;
  }

  /** Throw the held conclusions away without delivering (stop / re-bind). */
  private discardPendingFinal(): void {
    for (const entry of this.pendingFinal.values()) {
      if (entry.settle) clearTimeout(entry.settle);
      if (entry.ceiling) clearTimeout(entry.ceiling);
    }
    this.pendingFinal.clear();
  }

  /**
   * Drop one session's hold without delivering it. Used on error: the error
   * notice IS the outcome, so a stale "conclusion" must not follow it.
   */
  private dropPendingFinal(sessionId: string): void {
    const entry = this.pendingFinal.get(sessionId);
    if (!entry) return;
    this.pendingFinal.delete(sessionId);
    if (entry.settle) clearTimeout(entry.settle);
    if (entry.ceiling) clearTimeout(entry.ceiling);
  }

  /**
   * `agent/status` mirror: a running agent means a round is in flight, so the
   * countdown stops; going idle arms it. `agent.id` IS the session id in DSH
   * (`Agent.id: SessionId`), so no extra mapping is needed.
   */
  handleAgentStatus(sessionId: string, status: string): void {
    if (!this.finalOnlyEnabled()) return;
    if (status === "running") {
      this.cancelFinalSettle(sessionId);
      return;
    }
    if (status === "idle") {
      const entry = this.pendingFinal.get(sessionId);
      if (entry) this.armFinalSettle(entry);
    }
  }

  // ─── Upstream streaming / execution-process layer ───

  /** Flush accumulated process on the FIRST prose chunk, before the response commits. */
  handleAssistantStream(sessionId: string, frame: AssistantStreamFrame): void {
    const user = this.userForAgent(sessionId);
    if (this.interactionStopped || !user || this.isSilent() || !this.token || this.tokenGiveUp) {
      this.assistantStreams.delete(sessionId);
      return;
    }
    if (frame.type === "start") {
      this.assistantStreams.set(sessionId, {
        attemptId: frame.attemptId, revision: frame.revision, turn: frame.turn, step: frame.step,
        lastIndex: -1, proseStarted: false, reasoning: new Map(), handledReasoning: new Set(),
      });
      return;
    }
    const stream = this.assistantStreams.get(sessionId);
    // The runtime allocates a fresh `revision` for EVERY emitted frame (start,
    // each chunk, end), so a strictly newer value — never an equal one —
    // identifies a frame of the live attempt. Requiring equality here dropped
    // every chunk and silently pushed the process back to the durable commit.
    if (!stream || stream.attemptId !== frame.attemptId || frame.revision <= stream.revision) return;
    stream.revision = frame.revision;
    if (frame.type === "end") {
      if (frame.outcome.kind === "committed" && frame.outcome.eventType === "assistant/message" && stream.handledReasoning.size) {
        this.streamedReasoning.set(JSON.stringify([sessionId, frame.outcome.seq]), new Set(stream.handledReasoning));
        if (this.streamedReasoning.size > 256) this.streamedReasoning.delete(this.streamedReasoning.keys().next().value!);
      }
      this.assistantStreams.delete(sessionId);
      return;
    }
    if (frame.index <= stream.lastIndex) return;
    stream.lastIndex = frame.index;
    const chunk = frame.chunk;
    const index = chunk.index;
    if (chunk.type === "reasoning-delta" && typeof index === "number" && typeof chunk.text === "string") {
      // Only the first line is visible in the desktop collapsed row.
      const prior = stream.reasoning.get(index) ?? "";
      if (!prior.includes("\n")) stream.reasoning.set(index, (prior + chunk.text).slice(0, 1000));
    } else if (chunk.type === "block-end" && chunk.block?.type === "reasoning" && typeof index === "number") {
      stream.reasoning.set(index, chunk.block.text ?? "");
    }
    const prose = chunk.type === "text-delta" ? chunk.text
      : chunk.type === "block-end" && chunk.block?.type === "text" ? chunk.block.text : undefined;
    if (!stream.proseStarted && typeof prose === "string" && prose.trim()) {
      stream.proseStarted = true;
      for (const [blockIndex, text] of stream.reasoning) {
        if (!stream.handledReasoning.has(blockIndex) && text.trim()) {
          this.processFor(sessionId)?.addReasoning({ type: "reasoning", text });
          stream.handledReasoning.add(blockIndex);
        }
      }
      this.flushProcess(sessionId, user.userId);
    }
  }

  private processFor(sessionId: string): ExecutionProcess | undefined {
    if (this.isSilent() || !this.token || this.tokenGiveUp) return undefined;
    let process = this.processes.get(sessionId);
    if (!process) {
      process = new ExecutionProcess(this.userForAgent(sessionId)?.cwd);
      this.processes.set(sessionId, process);
    }
    return process;
  }

  private flushProcess(sessionId: string, userId: string): void {
    const process = this.processes.get(sessionId);
    if (this.isSilent() || !this.token || this.tokenGiveUp || this.userForAgent(sessionId)?.userId !== userId) {
      this.processes.delete(sessionId);
      return;
    }
    const text = process?.take(this.config.textChunkLimit);
    // 结论模式 holds the whole task, so the 「执行过程」 group — reasoning and
    // tool activity, i.e. exactly the intermediate narration the mode exists to
    // suppress — is DROPPED rather than pushed. `flushProcess` is the single
    // sink for it (assistant text blocks, turn/end, cards, agent error), so one
    // guard here covers every path. Without this the mode would still emit one
    // process message per auto-continued round and the flood would persist.
    if (text && !this.finalOnlyEnabled()) this.pushOutput(userId, text, true);
  }

  private pushOutput(userId: string, text: string, plainText = false): void {
    void this.sendReply(userId, text, { plainText }).catch((err) => this.log(`output send failed: ${String(err)}`));
  }

  /** Drop unfinished process / silent prose when its conversation leaves the live feed. */
  clearSessionOutput(sessionId: string): void {
    this.assistantStreams.delete(sessionId);
    for (const key of this.streamedReasoning.keys()) {
      if ((JSON.parse(key) as [string, number])[0] === sessionId) this.streamedReasoning.delete(key);
    }
    this.processes.delete(sessionId);
    this.silentBuffers.delete(sessionId);
  }

  /** Notify the bound user of an agent error. */
  handleAgentError(agentId: string, error: unknown): void {
    const user = this.userForAgent(agentId);
    if (user) this.flushProcess(agentId, user.userId);
    this.clearSessionOutput(agentId);
    if (!user) {
      void this.notifyCrossSessionError(agentId, error);
      return;
    }
    this.endTyping(user.userId, "agent-error");
    // The error is the outcome: never follow it with a stale held conclusion.
    this.dropPendingFinal(agentId);
    // Error text is untrusted prose: a failing request often quotes the
    // Authorization header or an API key back at us. Mask before it
    // crosses into WeChat (the one place assistant-visible text is not
    // masked — see `maskSecrets`).
    void this.sendReply(user.userId, `⚠️ Agent 出错: ${maskSecrets(String(error))}`).catch(() => {});
    void this.notifyCrossSessionError(agentId, error);
  }

  // ─── Host waterfalls: approval/question cards (GUI-equivalent mirror) ───

  /**
   * Plugin dispose only — abandon pending WeChat waiters so `next()` (GUI)
   * can still settle. WeChat reconnect/logout must NOT call this.
   */
  stopInteraction(): void {
    this.interactionStopped = true;
    for (const [userId, list] of [...this.pendingApprovals.entries()]) {
      for (const card of [...list]) {
        this.removeApprovalCard(userId, card.rpcId);
      }
    }
    for (const [userId, list] of [...this.pendingQuestions.entries()]) {
      for (const card of [...list]) {
        this.removeQuestionCard(userId, card.rpcId);
      }
    }
  }

  private sessionIdOfRequest(req: { agent?: { id?: string; session?: { header?: { id?: string }; id?: string } } }): string {
    const agent = req.agent;
    return agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id ?? "";
  }

  /**
   * DSH 0.1.2 Web cards dismiss only when the waterfall `request.signal`
   * aborts (Gateway then pushes a `cancel` frame). The tool's own
   * `exec.signal` must stay live so the turn can continue after a WeChat
   * answer — so we replace `req.signal` with a fork for `next()` (GUI)
   * and abort only that fork when this answerer returns. The original
   * turn abort is forwarded onto the fork so a GUI Stop still withdraws
   * the Web card.
   */
  private forkGuiCardSignal(req: { signal?: AbortSignal }): AbortController {
    const guiAbort = new AbortController();
    const original = req.signal;
    if (original) {
      const forward = () => {
        if (!guiAbort.signal.aborted) guiAbort.abort(original.reason);
      };
      if (original.aborted) forward();
      else original.addEventListener("abort", forward, { once: true });
    }
    (req as { signal?: AbortSignal }).signal = guiAbort.signal;
    return guiAbort;
  }

  private abortGuiCard(guiAbort: AbortController): void {
    if (guiAbort.signal.aborted) return;
    guiAbort.abort(new Error("dsh-wechat: settled from WeChat"));
  }

  /**
   * Host `approval/request` waterfall answerer. Races the GUI (`next()`)
   * against a WeChat reply so whoever answers first wins. No WeChat peer
   * → immediately `next()`. Soft timeout withdraws the WeChat waiter
   * without deciding, leaving the GUI card live.
   */
  async answerApprovalRequest(
    req: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (this.interactionStopped) return next();
    if (req.signal?.aborted) return next();
    const sessionId = this.sessionIdOfRequest(req);
    const toolName = typeof req.toolName === "string" && req.toolName ? req.toolName : "?";
    if (!sessionId) return next();
    const userId = this.recipientForSession(sessionId);
    if (!userId) {
      this.log(`approval/request ignored (no WeChat peer for session ${sessionId})`);
      return next();
    }
    const guiAbort = this.forkGuiCardSignal(req);

    const rpcId = `wx-appr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const approvalId =
      typeof req.callId === "string" && req.callId ? req.callId : rpcId;
    let settleWechat: ((outcome: "allowed-once" | "rejected") => void) | null = null;
    const wechat = new Promise<"allowed-once" | "rejected">((resolve) => {
      settleWechat = resolve;
    });
    const card: PendingApproval = {
      rpcId,
      sessionId,
      approvalId,
      userId,
      toolName,
      reason: typeof req.reason === "string" ? req.reason : undefined,
      askedAt: Date.now(),
      settled: false,
      settleWechat,
      timer: setTimeout(() => {
        if (card.settled) return;
        this.removeApprovalCard(userId, rpcId);
        void this.sendReply(
          userId,
          `⏰ 权限卡超时未回复（${toolName}），已移除；可在 DSH 界面继续处理。`,
        ).catch(() => {});
      }, this.config.cardTimeoutMs),
    };
    const list = this.pendingApprovals.get(userId) ?? [];
    list.push(card);
    this.pendingApprovals.set(userId, list);
    const userState = this.state.getUser(userId);
    if (userState?.sessionId === sessionId || this.shouldNotifyCrossSession(userId)) {
      this.pushCardOnce(userId, rpcId, () => this.sendApprovalCard(userId, card));
    }

    const gui = Promise.resolve()
      .then(() => next())
      .then((outcome) => ({ source: "gui" as const, outcome }))
      .catch((err) => {
        this.log(`approval next() failed: ${String(err)}`);
        return { source: "gui" as const, outcome: "unavailable" as ApprovalOutcome };
      });
    const wechatWrapped = wechat.then((outcome) => ({ source: "wechat" as const, outcome }));

    const winner = await Promise.race([gui, wechatWrapped]);
    void gui.then(() => undefined, () => undefined);
    void wechatWrapped.then(() => undefined, () => undefined);
    this.removeApprovalCard(userId, rpcId);
    this.abortGuiCard(guiAbort);
    if (winner.source === "gui") {
      if (this.shouldNotifyCrossSession(userId)) {
        const label =
          winner.outcome === "allowed-once"
            ? "✅ 已允许"
            : winner.outcome === "rejected"
              ? "⛔ 已拒绝"
              : "🚫 已取消";
        void this.sendReply(userId, `🔒 权限请求结果：${label}（${toolName}）`).catch(() => {});
      }
    }
    return winner.outcome;
  }

  /**
   * Host `user-questions/request` waterfall answerer. Same race as
   * approvals: WeChat vs GUI, first settle wins. Soft timeout withdraws
   * the WeChat waiter without answering.
   */
  async answerQuestionRequest(
    req: QuestionRequestLike,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    if (this.interactionStopped) return next();
    if (req.signal?.aborted) return next();
    const sessionId = this.sessionIdOfRequest(req);
    const questions = req.questions;
    if (!sessionId || !Array.isArray(questions) || questions.length === 0) return next();
    const userId = this.recipientForSession(sessionId);
    if (!userId) {
      this.log(`user-questions/request ignored (no WeChat peer for session ${sessionId})`);
      return next();
    }
    const guiAbort = this.forkGuiCardSignal(req);

    const rpcId = `wx-q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let settleWechat: ((answer: AskUserQuestionAnswer) => void) | null = null;
    let cancelWechat: ((reason: unknown) => void) | null = null;
    const wechat = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      settleWechat = resolve;
      cancelWechat = reject;
    });
    const card: PendingQuestion = {
      rpcId,
      sessionId,
      userId,
      items: questions,
      askedAt: Date.now(),
      settled: false,
      settleWechat,
      cancelWechat,
      timer: setTimeout(() => {
        if (card.settled) return;
        this.removeQuestionCard(userId, rpcId);
        void this.sendReply(userId, "⏰ 提问卡超时未回复，已移除；可在 DSH 界面继续回答。").catch(() => {});
      }, this.config.cardTimeoutMs),
    };
    const list = this.pendingQuestions.get(userId) ?? [];
    list.push(card);
    this.pendingQuestions.set(userId, list);
    const userState = this.state.getUser(userId);
    if (userState?.sessionId === sessionId || this.shouldNotifyCrossSession(userId)) {
      this.pushCardOnce(userId, rpcId, () => this.sendQuestionCard(userId, card, questions));
    }

    type QuestionWinner =
      | { source: "gui"; answer: AskUserQuestionAnswer }
      | { source: "wechat"; answer: AskUserQuestionAnswer };
    const gui = Promise.resolve()
      .then(() => next())
      .then((answer): QuestionWinner => ({ source: "gui", answer }));
    const wechatWrapped = wechat.then((answer): QuestionWinner => ({ source: "wechat", answer }));

    try {
      const winner = await Promise.race([gui, wechatWrapped]);
      this.removeQuestionCard(userId, rpcId);
      if (winner.source === "gui" && this.shouldNotifyCrossSession(userId)) {
        void this.sendReply(userId, "✅ 提问已回答。").catch(() => {});
      }
      return winner.answer;
    } catch (err) {
      this.removeQuestionCard(userId, rpcId);
      if (this.shouldNotifyCrossSession(userId)) {
        void this.sendReply(userId, "🚫 提问已取消。").catch(() => {});
      }
      throw err;
    } finally {
      // Dismiss the Web composer card (0.1.2 listens to request.signal).
      this.abortGuiCard(guiAbort);
      // The loser of the race (GUI next() or a leftover WeChat waiter) must
      // not become an unhandled rejection after this answerer returns.
      void gui.then(() => undefined, () => undefined);
      void wechatWrapped.then(() => undefined, () => undefined);
    }
  }

  /**
   * Test / replay helper: register a card without holding a live waterfall.
   * Production cards come from {@link answerApprovalRequest} /
   * {@link answerQuestionRequest}. Kept so existing unit tests can seed
   * pending tables without spinning a Host waterfall.
   */
  handleMuxFrame(frame: {
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
          this.log(`approval/requested ignored (no WeChat peer for session ${sessionId})`);
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
          settled: false,
          settleWechat: null,
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
        const userState = this.state.getUser(userId);
        if (userState?.sessionId === sessionId || this.shouldNotifyCrossSession(userId)) {
          this.pushCardOnce(userId, frame.rpcId, () => this.sendApprovalCard(userId, card));
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
          this.log(`question/requested ignored (no WeChat peer for session ${sessionId})`);
          return;
        }
        const card: PendingQuestion = {
          rpcId: frame.rpcId,
          sessionId,
          userId,
          items: questions,
          askedAt: Date.now(),
          settled: false,
          settleWechat: null,
          cancelWechat: null,
          timer: setTimeout(() => {
            this.removeQuestionCard(userId, frame.rpcId);
            void this.sendReply(userId, "⏰ 提问卡超时未回复，已移除；可在 DSH 界面继续回答。").catch(() => {});
          }, this.config.cardTimeoutMs),
        };
        const list = this.pendingQuestions.get(userId) ?? [];
        list.push(card);
        this.pendingQuestions.set(userId, list);
        const userState = this.state.getUser(userId);
        if (userState?.sessionId === sessionId || this.shouldNotifyCrossSession(userId)) {
          this.pushCardOnce(userId, frame.rpcId, () => this.sendQuestionCard(userId, card, questions));
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
      ? (await this.ops.readSessionTitle(sessionId, record.header.cwd, record.header)) ?? sessionId.slice(0, 8)
      : sessionId.slice(0, 8);
    return `📂 ${workspace} · 💬 ${title}`;
  }

  /**
   * Block-quoted preview of a session's last assistant text for a
   * cross-session notice, or "" when there is nothing to quote.
   *
   * Two deliberate properties:
   *   - the TAIL, not the head — an assistant message opens with preamble
   *     and closes with the conclusion, and the notice exists to convey
   *     the conclusion;
   *   - `maskSecrets` — assistant prose can echo a token or hash it was
   *     shown. Only this excerpt is masked; a normal reply body never is
   *     (the mask's hex/base64 rules would eat its commit SHAs).
   * Measured in code points, so a tail of emoji is not half a surrogate.
   */
  private previewSuffix(sessionId: string): string {
    const preview = this.lastAssistantTextBySession.get(sessionId);
    if (!preview) return "";
    const { tail, truncated } = tailByCodePoint(preview, PREVIEW_CHARS);
    return `\n> ${maskSecrets(tail)}${truncated ? "…" : ""}`;
  }

  /**
   * Send one mirrored approval card with its session provenance header.
   * The P{n} number is the card's index across answerable approvals
   * (current session, plus other sessions while the decision gate is on).
   */
  private async sendApprovalCard(userId: string, card: PendingApproval): Promise<void> {
    this.flushProcess(card.sessionId, userId);
    const context = await this.sessionContextLabel(card.sessionId);
    const { index, total } = this.pnOfCard(userId, "approval", card.rpcId);
    const currentId = this.state.getUser(userId)?.sessionId;
    const note = currentId && card.sessionId === currentId
      ? ""
      : `\n\n（❗来自其他会话 — 回复 P${index}=1 允许 / P${index}=2 拒绝；P${index}=/rq 关闭此卡。直接打字会发给当前会话。）`;
    await this.sendReply(userId, `${context}\n${formatApprovalCard(card, index, total)}${note}`);
  }

  /**
   * Send one mirrored question card with its session provenance header.
   * The P{n} number is the card's index across answerable questions;
   * multi-card replies use `P{n}=` to pick the card.
   */
  private async sendQuestionCard(
    userId: string,
    card: PendingQuestion,
    questions: AskUserQuestionItem[],
  ): Promise<void> {
    this.flushProcess(card.sessionId, userId);
    const context = await this.sessionContextLabel(card.sessionId);
    const { index, total } = this.pnOfCard(userId, "question", card.rpcId);
    const header = total > 1 ? `❓ 提问卡 ${index}/${total}` : "❓ 提问";
    const currentId = this.state.getUser(userId)?.sessionId;
    const foreign = currentId && card.sessionId !== currentId
      ? `\n\n（❗来自其他会话 — 回复 P${index}=… 指定本卡，例如 P${index}=1；P${index}=/rq 关闭此卡。直接打字会发给当前会话。）`
      : "";
    const tip = !foreign && total > 1
      ? `\n\n此卡编号 P${index}：回复 P${index}=… 指定本卡；P${index}=/rq 关闭此卡。`
      : "";
    await this.sendReply(userId, `${header}\n${context}\n${formatQuestionForWeChat(questions)}${foreign}${tip}`);
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
      const users = this.state.all();
      // Canonical compare (host rule): the session's recorded cwd and each
      // user's cwd may spell the same directory differently, and the
      // workspace roster is the authority the host itself uses.
      const resolved = await this.canonicalizePaths([
        record.header.cwd,
        ...workspaces.map((w) => w.path),
        ...users.map((u) => u.cwd),
      ]);
      const sessionCwd = resolved.get(record.header.cwd);
      const owningWs =
        workspaces.find((w) => resolved.get(w.path) === sessionCwd)
        ?? workspaces.find((w) => w.sessionIds.includes(sessionId));
      if (owningWs) {
        const wsCwd = resolved.get(owningWs.path);
        for (const user of users) {
          if (!seen.has(user.userId) && resolved.get(user.cwd) === wsCwd) {
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
    if (!this.notifyTaskEventsEnabled()) return;
    const recipients = await this.resolveCrossSessionRecipients(sessionId);
    if (recipients.length === 0) return;
    const context = await this.sessionContextLabel(sessionId);
    const previewSuffix = this.previewSuffix(sessionId);
    const body = context + "\n✅ 任务已完成" + previewSuffix + "\n发送 /session switch <编号> 切换查看。";
    for (const user of recipients) {
      if (user.sessionId === sessionId) continue;
      if (!this.notifyTaskEventsEnabled()) continue;
      const holdMode = this.finalOnlyEnabled();
      // Same ordering rule as the bound-user path: the immediate send must
      // confirm reachability before claiming the dedupe slot, while the hold
      // path marks unconditionally (its delivery is deferred and parked).
      if (!holdMode && !this.botReady()) continue;
      const set = this.notifiedCrossSessionTurns.get(user.userId) ?? new Set<string>();
      if (set.has(sessionId)) continue;
      set.add(sessionId);
      this.notifiedCrossSessionTurns.set(user.userId, set);
      // Arm the cleanup for every path that marks.
      setTimeout(() => { this.notifiedCrossSessionTurns.get(user.userId)?.delete(sessionId); }, 30_000);
      // 结论模式: hold instead of one card per auto-continued round.
      if (holdMode) {
        this.foldFinalRound(sessionId);
        this.holdFinalNotice(user.userId, sessionId, body);
        continue;
      }
      void this.sendReply(user.userId, body).catch(() => {});
    }
  }

  private async notifyCrossSessionError(sessionId: string, error: unknown): Promise<void> {
    if (!this.notifyTaskEventsEnabled()) return;
    const recipients = await this.resolveCrossSessionRecipients(sessionId);
    if (recipients.length === 0) return;
    const context = await this.sessionContextLabel(sessionId);
    // Same reasoning as the bound-user path: exception text is the one
    // outbound body that routinely carries credentials, so it is masked.
    const msg = maskSecrets(String(error)).slice(0, 200);
    const body = context + "\n⚠️ 任务报错: " + msg + "\n发送 /session switch <编号> 查看。";
    for (const user of recipients) {
      if (user.sessionId === sessionId) continue;
      if (!this.notifyTaskEventsEnabled()) continue;
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
   * it that were NOT already pushed in full on arrival (a card pushed for
   * a non-current session must not repeat on switch; /history re-shows
   * everything on demand).
   */
  private async flushPendingCardsForSession(userId: string, sessionId: string): Promise<void> {
    const approvals = (this.pendingApprovals.get(userId) ?? []).filter((c) => c.sessionId === sessionId);
    const questions = (this.pendingQuestions.get(userId) ?? []).filter((c) => c.sessionId === sessionId);

    const unseenApprovals = approvals.filter((c) => !this.isCardPushed(userId, c.rpcId));
    const unseenQuestions = questions.filter((c) => !this.isCardPushed(userId, c.rpcId));
    if (unseenApprovals.length > 0 || unseenQuestions.length > 0) {
      for (const card of unseenApprovals) {
        this.pushCardOnce(userId, card.rpcId, () => this.sendApprovalCard(userId, card));
      }
      for (const card of unseenQuestions) {
        this.pushCardOnce(userId, card.rpcId, () => this.sendQuestionCard(userId, card, card.items));
      }
    }

    this.clearCrossSessionTurnNotified(userId, sessionId);
  }

  /** Push every still-pending card that has not yet been shown on WeChat. */
  private async flushUnseenCardsForUser(userId: string): Promise<void> {
    const approvals = (this.pendingApprovals.get(userId) ?? []).filter((c) => !this.isCardPushed(userId, c.rpcId));
    const questions = (this.pendingQuestions.get(userId) ?? []).filter((c) => !this.isCardPushed(userId, c.rpcId));
    if (approvals.length === 0 && questions.length === 0) return;
    for (const card of approvals) {
      this.pushCardOnce(userId, card.rpcId, () => this.sendApprovalCard(userId, card));
    }
    for (const card of questions) {
      this.pushCardOnce(userId, card.rpcId, () => this.sendQuestionCard(userId, card, card.items));
    }
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

  /**
   * Cards the user may answer from WeChat right now.
   * Gate off → current session only (unseen background cards stay silent).
   * Gate on  → every pending card (they were / will be pushed in full).
   */
  private answerableApprovals(userId: string): PendingApproval[] {
    if (this.shouldNotifyCrossSession(userId)) return this.pendingApprovals.get(userId) ?? [];
    return this.pendingCardsForCurrentSession(userId).approvals;
  }

  private answerableQuestions(userId: string): PendingQuestion[] {
    if (this.shouldNotifyCrossSession(userId)) return this.pendingQuestions.get(userId) ?? [];
    return this.pendingCardsForCurrentSession(userId).questions;
  }

  /**
   * Global P{n} order: questions first, then approvals. One namespace so a
   * plan card labelled P1 is not intercepted as a permission reply.
   */
  private answerableCards(userId: string): Array<
    { kind: "question"; card: PendingQuestion } | { kind: "approval"; card: PendingApproval }
  > {
    return [
      ...this.answerableQuestions(userId).map((card) => ({ kind: "question" as const, card })),
      ...this.answerableApprovals(userId).map((card) => ({ kind: "approval" as const, card })),
    ];
  }

  private pnOfCard(userId: string, kind: "question" | "approval", rpcId: string): { index: number; total: number } {
    const all = this.answerableCards(userId);
    const idx = all.findIndex((c) => c.kind === kind && c.card.rpcId === rpcId);
    return { index: idx >= 0 ? idx + 1 : all.length, total: all.length };
  }

  /**
   * Snapshot `rpcId → P{n}` for every answerable card, taken ONCE at the
   * start of an inbound reply.
   *
   * A receipt must name the number the card was PRINTED with, and `P{n}` is
   * a live position in the pending tables: settling a card removes it from
   * those tables before the receipt is composed (measured — a lookup taken
   * after the removal returns nothing, not a shifted number). Resolving
   * against a map frozen before the batch therefore both preserves the
   * printed number and keeps `P1=1 P2=2` from degrading to a numberless
   * receipt.
   */
  private cardIndices(userId: string): Map<string, number> {
    const map = new Map<string, number>();
    for (const [i, entry] of this.answerableCards(userId).entries()) {
      map.set(entry.card.rpcId, i + 1);
    }
    return map;
  }

  // ─── Approval replies ───

  /** Background task completion/error notice gate (decision cards only follow `crossSessionNotify`). */
  private notifyTaskEventsEnabled(): boolean {
    return this.config.notifyTaskEvents === true;
  }

  /** Record that the card's full content was pushed to WeChat for this user. */
  private markCardPushed(userId: string, rpcId: string): void {
    if (!rpcId) return;
    const set = this.pushedCardRpcIds.get(userId) ?? new Set<string>();
    set.add(rpcId);
    this.pushedCardRpcIds.set(userId, set);
  }

  /**
   * Push one card and claim its one-shot "already pushed" mark — in that
   * order, and only when the card can actually leave the process.
   *
   * Why the order matters (S5): `sendReply` DROPS its payload while the bot is
   * logged out or mid re-login (it does not park it), so marking first burns
   * the one-shot on a delivery that never happened, and `isCardPushed` then
   * blocks the re-push until the card times out — the user simply never sees
   * the card. Reachability is therefore confirmed BEFORE the mark is taken,
   * and the mark is rolled back if the send itself throws (the same
   * mark-then-rollback shape `notifyCachePendingLocked` uses). A "parked"
   * outcome is a success for this purpose: the card text is in the durable
   * FIFO and will be flushed.
   */
  private pushCardOnce(userId: string, rpcId: string, send: () => Promise<void>): void {
    if (this.interactionStopped) return;
    if (!this.botReady() || this.tokenGiveUp) {
      this.log(
        `card ${rpcId} not marked as pushed: bot unreachable `
        + "(no token / -14 give-up), so a later attempt can still deliver it",
      );
      return;
    }
    this.markCardPushed(userId, rpcId);
    void send().catch((err) => {
      this.unmarkCardPushed(userId, rpcId);
      this.log(`card ${rpcId} push failed; pushed-mark rolled back so it can be re-sent: ${String(err)}`);
    });
  }

  /** Whether the card's full content was already pushed to WeChat for this user. */
  private isCardPushed(userId: string, rpcId: string): boolean {
    return this.pushedCardRpcIds.get(userId)?.has(rpcId) ?? false;
  }

  /** Drop the pushed marker when the card leaves the pending table. */
  private unmarkCardPushed(userId: string, rpcId: string): void {
    this.pushedCardRpcIds.get(userId)?.delete(rpcId);
  }

  private isCardCloseCommand(text: string): boolean {
    return parseRejectQuestionCommand(text) !== null || parseRejectPermissionCommand(text) !== null;
  }

  /** Route every `P{n}=` in the line onto the globally numbered card. */
  private async handlePnReplies(userId: string, text: string): Promise<void> {
    const parts = parseAllPnCardReplies(text);
    const all = this.answerableCards(userId);
    if (parts.length === 0) return;
    if (all.length === 0) {
      await this.sendReply(userId, "✅ 当前没有待处理卡片。");
      return;
    }
    // Receipts must name the number the user typed. The card is removed from
    // the live tables as soon as it is settled, so the batch resolves against
    // this snapshot instead of a post-removal lookup.
    const indices = new Map(all.map((entry, i) => [entry.card.rpcId, i + 1]));
    for (const part of parts) {
      if (part.index < 1 || part.index > all.length) {
        await this.sendReply(userId, `⚠️ 卡片编号超出范围（1-${all.length}）。`);
        continue;
      }
      const target = all[part.index - 1]!;
      if (this.isCardCloseCommand(part.rest)) {
        if (target.kind === "question") await this.rejectOneQuestion(userId, target.card, part.index);
        else await this.rejectOneApproval(userId, target.card, part.index);
        continue;
      }
      if (target.kind === "question") {
        await this.answerOneQuestion(userId, target.card, part.rest, indices);
      } else {
        const { decisions, warnings } = parseApprovalReply(part.rest, [target.card]);
        await this.applyApprovalDecisions(userId, [target.card], decisions, warnings, indices);
      }
    }
  }

  private async handleApprovalReply(userId: string, text: string): Promise<void> {
    const list = this.answerableApprovals(userId);
    if (list.length === 0) {
      return;
    }
    // Frozen before any card is settled. `removeApprovalCard` /
    // `removeQuestionCard` delete from the live tables *before* the receipt
    // is composed, so a lookup taken afterwards yields no number at all —
    // this snapshot is what makes the receipt name the printed card.
    const indices = this.cardIndices(userId);

    const pn = parsePnCardReply(text);
    if (pn) {
      if (pn.index < 1 || pn.index > list.length) {
        await this.sendReply(userId, `⚠️ 卡片编号超出范围（1-${list.length}）。`);
        return;
      }
    } else {
      const currentId = this.state.getUser(userId)?.sessionId;
      const local = currentId ? list.filter((c) => c.sessionId === currentId) : [];
      if (local.length === 0) {
        await this.sendReply(userId, `⚠️ 其它会话的权限卡请用 P1=1 / P2=2 指定编号；关闭用 P1=/rq。直接打字会发给当前会话。`);
        return;
      }
      const { decisions, warnings } = parseApprovalReply(text, local);
      await this.applyApprovalDecisions(userId, local, decisions, warnings, indices);
      return;
    }

    const { decisions, warnings } = parseApprovalReply(text, list);
    await this.applyApprovalDecisions(userId, list, decisions, warnings, indices);
  }

  private async applyApprovalDecisions(
    userId: string,
    list: PendingApproval[],
    decisions: Array<{ rpcId: string; reply: "once" | "reject" }>,
    warnings: string[],
    indices: ReadonlyMap<string, number>,
  ): Promise<void> {
    const snapshot = [...list];
    for (const decision of decisions) {
      const entry = snapshot.find((c) => c.rpcId === decision.rpcId);
      if (!entry) continue;
      this.removeApprovalCard(userId, decision.rpcId);
      const outcome = decision.reply === "once" ? "allowed-once" : "rejected";
      const receipt = await this.respondApproval(entry, outcome);
      if (!receipt.accepted) {
        void this.sendReply(userId, `ℹ️ 该权限请求已在其他端处理（${receipt.reason ?? "not-pending"}）。`).catch(() => {});
        continue;
      }
      // The WeChat reply is what settled this card, so the user gets a
      // direct receipt. Deliberately NOT gated by crossSessionNotify /
      // notifyTaskEvents / silent: those gate *unsolicited* cross-session
      // notices, while this confirms an action the user just took — same
      // class as the existing `/rq` receipt.
      const pn = indices.get(entry.rpcId);
      const label = decision.reply === "once" ? "✅ 已允许" : "⛔ 已拒绝";
      void this.sendReply(
        userId,
        pn === undefined ? `${label}（${entry.toolName}）。` : `${label}权限卡 P${pn}（${entry.toolName}）。`,
      ).catch(() => {});
    }
    for (const warning of warnings) {
      void this.sendReply(userId, `⚠️ ${warning}`).catch(() => {});
    }
    if (decisions.length === 0) {
      await this.sendReply(userId, "⚠️ 无法识别的权限回复。回复 1（允许一次）/ 2（拒绝）；其它会话用 P1=1；关闭用 /rq 或 P1=/rq。");
    }
  }

  private async respondApproval(
    entry: PendingApproval,
    outcome: "allowed-once" | "rejected",
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (entry.settled) return { accepted: false, reason: "not-pending" };
    entry.settled = true;
    // S4 audit: one line per decision actually applied (a duplicate attempt
    // returns early above and is not a decision).
    this.audit.record({
      event: "decision",
      kind: "approval",
      user: maskUserId(entry.userId),
      session: maskUserId(entry.sessionId),
      tool: entry.toolName,
      decision: outcome,
    });
    if (entry.settleWechat) {
      entry.settleWechat(outcome);
      return { accepted: true };
    }
    // Test-seeded cards have no live waterfall waiter; treating the
    // WeChat reply as accepted keeps /rp and reply grammar working.
    return { accepted: true };
  }

  private removeApprovalCard(userId: string, rpcId: string): void {
    const list = this.pendingApprovals.get(userId);
    if (!list) return;
    const entry = list.find((c) => c.rpcId === rpcId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.unmarkCardPushed(userId, rpcId);
    const next = list.filter((c) => c.rpcId !== rpcId);
    if (next.length > 0) this.pendingApprovals.set(userId, next);
    else this.pendingApprovals.delete(userId);
  }

  private async rejectOneApproval(userId: string, entry: PendingApproval, index: number): Promise<void> {
    this.removeApprovalCard(userId, entry.rpcId);
    const receipt = await this.respondApproval(entry, "rejected");
    if (index <= 0) return;
    if (!receipt.accepted) {
      await this.sendReply(userId, `ℹ️ 权限请求 ${entry.toolName} 已在其他端处理。`);
      return;
    }
    await this.sendReply(userId, `✅ 已关闭权限卡 P${index}（${entry.toolName}）。`);
  }

  // ─── Question replies ───

  private async handleQuestionReply(userId: string, text: string): Promise<void> {
    const list = this.answerableQuestions(userId);
    if (list.length === 0) {
      return;
    }
    // Same frozen numbering as the approval path — the card leaves the live
    // tables before the receipt is composed, so the number must come from
    // the snapshot taken above.
    const indices = this.cardIndices(userId);

    const pn = parsePnCardReply(text);
    let entry: PendingQuestion;
    let answerText: string;
    if (pn) {
      if (pn.index < 1 || pn.index > list.length) {
        await this.sendReply(userId, `⚠️ 卡片编号超出范围（1-${list.length}）。`);
        return;
      }
      entry = list[pn.index - 1]!;
      answerText = pn.rest;
    } else {
      const currentId = this.state.getUser(userId)?.sessionId;
      const local = currentId ? list.filter((c) => c.sessionId === currentId) : [];
      if (local.length === 0) {
        await this.sendReply(userId, `⚠️ 其它会话的提问卡请用 P1=… 指定编号；关闭用 P1=/rq。直接打字会发给当前会话。`);
        return;
      }
      if (local.length > 1) {
        await this.sendReply(userId, `⚠️ 有 ${local.length} 张提问卡待处理。请用 P1=… 指定卡片；关闭用 /rq（当前会话）或 P1=/rq。`);
        return;
      }
      entry = local[0]!;
      answerText = text;
    }

    await this.answerOneQuestion(userId, entry, answerText, indices);
  }

  private async answerOneQuestion(
    userId: string,
    entry: PendingQuestion,
    answerText: string,
    indices: ReadonlyMap<string, number>,
  ): Promise<void> {
    const parsed = parseQuestionReply(answerText, entry.items);
    this.removeQuestionCard(userId, entry.rpcId);
    for (const warning of parsed.warnings) {
      void this.sendReply(userId, `⚠️ ${warning}`).catch(() => {});
    }
    const receipt = await this.respondQuestion(entry, buildAnswer(parsed, entry.items));
    if (!receipt.accepted) {
      void this.sendReply(userId, `ℹ️ 该提问已在其他端回答（${receipt.reason ?? "not-pending"}）。`).catch(() => {});
      return;
    }
    // Direct receipt for the user's own answer — see the note in
    // `applyApprovalDecisions`: this confirms a just-taken action, so it is
    // not gated by the cross-session / silent switches.
    const pn = indices.get(entry.rpcId);
    void this.sendReply(userId, pn === undefined ? "✅ 已回复提问卡。" : `✅ 已回复提问卡 P${pn}。`).catch(() => {});
  }

  private async respondQuestion(
    entry: PendingQuestion,
    answer: AskUserQuestionAnswer,
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (entry.settled) return { accepted: false, reason: "not-pending" };
    entry.settled = true;
    // S4 audit: the decision and its size, never the answer text (an answer
    // can quote anything the agent asked about).
    this.audit.record({
      event: "decision",
      kind: "question",
      user: maskUserId(entry.userId),
      session: maskUserId(entry.sessionId),
      items: entry.items.length,
      decision: "answered",
      chars: JSON.stringify(answer ?? "").length,
    });
    if (entry.settleWechat) {
      entry.settleWechat(answer);
      return { accepted: true };
    }
    return { accepted: true };
  }

  /** `/rq` — close pending cards of the current session only. */
  private async rejectCurrentSessionCards(userId: string): Promise<void> {
    const { approvals, questions } = this.pendingCardsForCurrentSession(userId);
    if (approvals.length === 0 && questions.length === 0) {
      await this.sendReply(userId, "✅ 当前会话没有待处理卡片。");
      return;
    }
    let closed = 0;
    for (const entry of [...questions]) {
      await this.rejectOneQuestion(userId, entry, 0);
      closed++;
    }
    for (const entry of [...approvals]) {
      await this.rejectOneApproval(userId, entry, 0);
      closed++;
    }
    await this.sendReply(userId, `✅ 已关闭当前会话 ${closed} 张卡片。`);
  }

  /** `P{n}=/rq` — close that globally numbered card. */
  private async rejectCardByPn(userId: string, index: number): Promise<void> {
    const all = this.answerableCards(userId);
    if (index < 1 || index > all.length) {
      await this.sendReply(userId, all.length > 0 ? `⚠️ 卡片编号超出范围（1-${all.length}）。` : "✅ 当前没有待处理卡片。");
      return;
    }
    const target = all[index - 1]!;
    if (target.kind === "question") await this.rejectOneQuestion(userId, target.card, index);
    else await this.rejectOneApproval(userId, target.card, index);
  }

  private async rejectOneQuestion(userId: string, entry: PendingQuestion, index: number): Promise<void> {
    this.removeQuestionCard(userId, entry.rpcId);
    if (!entry.settled) {
      entry.settled = true;
      const planKeep = this.planKeepPlanningAnswer(entry.items);
      if (planKeep && entry.settleWechat) {
        // Web UI closing a plan-review card selects "Keep planning" rather
        // than aborting the ask. Mirror that so the model gets the same
        // "revise the plan and present it again" tool error.
        entry.settleWechat(planKeep);
      } else if (entry.cancelWechat) {
        try {
          // Match Web composer's X: user closed the card (`ASK_CANCELLED`),
          // not a turn abort (`ASK_ABORTED`).
          const err = Object.assign(new Error("the user cancelled ask_user_question"), {
            name: "UserQuestionError",
            code: "ASK_CANCELLED",
          });
          entry.cancelWechat(err);
        } catch {
          // best effort
        }
      }
    }
    if (index > 0) await this.sendReply(userId, `✅ 已关闭提问卡 P${index}。`);
  }

  /**
   * Plan-mode `exit_plan_mode` review: dismissing the card is "Keep planning",
   * not an aborted ask. Detect via host intent, else the well-known review id.
   */
  private planKeepPlanningAnswer(items: AskUserQuestionItem[]): AskUserQuestionAnswer | undefined {
    if (items.length === 0) return undefined;
    const answers: AskUserQuestionAnswer["answers"] = [];
    let matched = false;
    for (const item of items) {
      const approve = item.intent?.kind === "plan-review" ? item.intent.approve : undefined;
      const isReview = item.intent?.kind === "plan-review" || item.id === "plan-review";
      if (!isReview) {
        answers.push({ id: item.id, selected: [] });
        continue;
      }
      matched = true;
      const keep =
        item.options?.find((o) => (approve ? o.label !== approve : /keep planning/i.test(o.label)))?.label
        ?? "Keep planning";
      answers.push({ id: item.id, selected: [keep] });
    }
    return matched ? { answers } : undefined;
  }

  private removeQuestionCard(userId: string, rpcId: string): void {
    const list = this.pendingQuestions.get(userId);
    if (!list) return;
    const entry = list.find((c) => c.rpcId === rpcId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.unmarkCardPushed(userId, rpcId);
    const next = list.filter((c) => c.rpcId !== rpcId);
    if (next.length > 0) this.pendingQuestions.set(userId, next);
    else this.pendingQuestions.delete(userId);
  }

  // ─── Slash command handlers ───

  private async handleNotifyCommand(userId: string, cmd: NotifyCommand): Promise<void> {
    if (cmd.kind === "status") {
      const on = this.shouldNotifyCrossSession(userId) ? "on" : "off";
      const task = this.notifyTaskEventsEnabled() ? "on" : "off";
      await this.sendReply(
        userId,
        `🔔 跨会话决策推送: ${on}（任意会话的权限/提问卡整卡推送，微信直接回复）\n跨会话任务完成提醒: ${task}\n切换决策推送: /notify on|off\n切换任务提醒: /notify tasks on|off`,
      );
      return;
    }
    if (cmd.kind === "on") {
      this.persistEditable({ crossSessionNotify: true });
      await this.sendReply(userId, "✅ 跨会话决策推送已开启。后台权限/提问卡会整卡推到微信，直接回复即可。");
      await this.flushUnseenCardsForUser(userId);
      return;
    }
    if (cmd.kind === "off") {
      this.persistEditable({ crossSessionNotify: false });
      await this.sendReply(userId, "🔕 跨会话决策推送已关闭。仅当前会话的卡可在微信回复。");
      return;
    }
    if (cmd.kind === "tasks-on") {
      this.persistEditable({ notifyTaskEvents: true });
      await this.sendReply(userId, "✅ 跨会话任务完成提醒已开启。");
      return;
    }
    if (cmd.kind === "tasks-off") {
      this.persistEditable({ notifyTaskEvents: false });
      await this.sendReply(userId, "🔕 跨会话任务完成提醒已关闭。");
      return;
    }
  }

  /**
   * Write one editable field both in memory and, when a ConfigStore is
   * attached, to `config.json`. Tests that construct the bridge without a
   * store still see the in-memory change for the rest of the process.
   */
  private persistEditable(patch: Partial<EditableConfig>): void {
    if (typeof patch.silent === "boolean" && patch.silent !== this.config.silent) {
      this.processes.clear();
      this.assistantStreams.clear();
      this.streamedReasoning.clear();
      if (!patch.silent) this.silentBuffers.clear();
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      (this.config as unknown as Record<string, unknown>)[key] = value;
    }
    try {
      this.configStore?.update(patch);
    } catch (err) {
      this.log(`persist config failed: ${String(err)}`);
    }
  }

  private async handleSurfaceCommand(userId: string, cmd: SurfaceCommand): Promise<void> {
    if (cmd.mode === "on") {
      this.persistEditable({ surfacePromptEnabled: true });
      await this.sendReply(userId, "✅ 微信渠道提示词已开启。下一轮微信消息会注入设置页中的提示词。");
      return;
    }
    if (cmd.mode === "off") {
      this.persistEditable({ surfacePromptEnabled: false });
      await this.sendReply(userId, "🔕 微信渠道提示词已关闭。");
      return;
    }
    const on = this.config.surfacePromptEnabled ? "on" : "off";
    await this.sendReply(
      userId,
      `微信渠道提示词: ${on}（/surface on|off 切换；正文在设置页编辑）`,
    );
  }

  private async handleSilentCommand(userId: string, mode: "on" | "off" | "status"): Promise<void> {
    const user = this.ensureBoundUser(userId);
    if (mode === "on") {
      this.setSilent(true, user.userId);
      await this.sendReply(userId, "🔇 静默模式已开启：每轮只发送最终回复。");
    } else if (mode === "off") {
      this.setSilent(false, user.userId);
      await this.sendReply(userId, "🔊 静默模式已关闭：思考与工具合并为执行过程，正文独立发送。");
    } else {
      await this.sendReply(userId, `静默模式: ${this.isSilent() ? "on" : "off"}（/silent on|off 切换）`);
    }
  }

  /** Global silent switch, mirrored onto the current peer so runtime reads stay consistent. */
  private setSilent(silent: boolean, userId?: string): void {
    this.persistEditable({ silent });
    const target = userId ?? this.peerUserId ?? this.state.all()[0]?.userId;
    if (target) this.state.update(target, { silent });
  }

  private isSilent(): boolean {
    return this.config.silent === true;
  }

  // ─── 结论模式 / final-only (/final) ───

  /**
   * `/final` — view or switch 结论模式. Mirrors `/silent`: the value is
   * persisted to `config.json` (so a re-scan keeps it) and the settings
   * page shows the same switch.
   *
   * Turning the mode OFF flushes whatever is held. A hold is a conclusion
   * the agent has already produced — the user just asked us to stop
   * holding things back, so handing it over now is the only reading that
   * does not silently destroy output. (Dispose does the same; only
   * logout / re-bind discard.)
   */
  private async handleFinalCommand(userId: string, cmd: FinalCommand): Promise<void> {
    if (cmd.mode === "on") {
      this.persistEditable({ finalOnly: true });
      await this.sendReply(
        userId,
        "📌 结论模式已开启：跨轮次的中间过程不再推送，整条任务停下后只发一条最终结论。\n"
        + "权限卡、提问卡、报错仍会立即推送；想看当前进度随时发 /flush。",
      );
      return;
    }
    if (cmd.mode === "off") {
      this.persistEditable({ finalOnly: false });
      const flushed = await this.flushAllPendingFinal("command-off");
      await this.sendReply(
        userId,
        flushed > 0
          ? `📤 结论模式已关闭；已取回 ${flushed} 条暂存的最终结论。之后每轮正常推送。`
          : "📤 结论模式已关闭：之后每轮正常推送。",
      );
      return;
    }
    const held = this.pendingFinal.size;
    await this.sendReply(
      userId,
      `结论模式: ${this.finalOnlyEnabled() ? "on" : "off"}`
      + (this.finalOnlyEnabled() && held > 0 ? `（暂存 ${held} 条，发 /flush 立即取回）` : "")
      + "\n切换: /final on|off（设置页「结论模式」同步，写入 config.json 后重新扫码仍保留）",
    );
  }

  // ─── 打字合并 / inbound merge window (/merge) ───

  /**
   * `/merge` — view or switch the inbound merge window. Mirrors `/silent`:
   * persisted to `config.json` (survives a re-scan), shown in the settings
   * page, bypasses a pending card, appears in `/help` and in
   * `LOCAL_COMMAND_NAMES` so a native command of the same name never shadows
   * it.
   *
   * Turning it OFF flushes the buffer first: those are the user's own words
   * and dropping them because they flipped a switch would silently swallow a
   * message (the same rule `/final off` follows).
   */
  private async handleMergeCommand(userId: string, cmd: MergeCommand): Promise<void> {
    if (cmd.mode === "on") {
      this.persistEditable({ mergeEnabled: true });
      await this.sendReply(
        userId,
        "🧵 打字合并已开启：连续几条消息会在你停手后合并成一轮。\n"
        + `静默 ${(this.mergeSilenceMs() / 1000).toFixed(1)}s / 最多 ${this.mergeMaxMsgs()} 条 / 最长 ${Math.round(this.mergeForcedReleaseMs() / 1000)}s 必发；`
        + "消息末尾 `..` 表示还要接着说，`!!` 表示立刻提交（这两个后缀会被去掉）。图片/文件不参与合并，会先把已输入的文字发出去。",
      );
      return;
    }
    if (cmd.mode === "off") {
      const pending = this.pendingMergedCount();
      this.persistEditable({ mergeEnabled: false });
      if (pending > 0) await this.flushMergedText(userId, "command-off");
      await this.sendReply(
        userId,
        pending > 0
          ? `🧵 打字合并已关闭；已把暂存的 ${pending} 条消息作为一轮发出。之后每条消息各自一轮。`
          : "🧵 打字合并已关闭：之后每条消息各自一轮。",
      );
      return;
    }
    await this.sendReply(
      userId,
      `🧵 打字合并: ${this.mergeStatusText()}`
      + "\n切换: /merge on|off（设置页「打字合并」同步，写入 config.json 后重新扫码仍保留）",
    );
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
    agent.cancel({ kind: "user" });
    await this.sendReply(userId, "🛑 已发送停止指令。");
  }

  // ─── Workspace / Session / Agent / Model commands ───

  private async handleWorkspaceCommand(userId: string, cmd: WorkspaceCommand): Promise<void> {
    const user = this.ensureBoundUser(userId);
    switch (cmd.kind) {
      case "list": {
        const workspaces = this.ops.listWorkspaces();
        if (workspaces.length === 0) {
          await this.sendReply(userId, "📂 暂无工作区。可用 /workspace add <路径> 添加。");
          return;
        }
        const archived = new Set(this.ops.archivedSessionIds());
        const shown = cmd.all ? workspaces : workspaces.slice(0, cmd.limit ?? LIST_DEFAULT);
        // The "current" marker compares canonical paths (same canon the host
        // uses for workspace membership) so a cwd spelled with a trailing
        // separator or a `.` segment still matches its workspace.
        const userCwd = await canonicalPath(user.cwd);
        const canonicalWsPaths = new Map<string, string>();
        const lines = [`📂 工作区列表（按添加顺序，共 ${workspaces.length} 个）`];
        for (let i = 0; i < shown.length; i++) {
          const ws = shown[i]!;
          let wsPath = canonicalWsPaths.get(ws.path);
          if (wsPath === undefined) {
            wsPath = await canonicalPath(ws.path);
            canonicalWsPaths.set(ws.path, wsPath);
          }
          const current = wsPath === userCwd ? " ◀ 当前" : "";
          const visibleCount = ws.sessionIds.filter((id) => !archived.has(id)).length;
          lines.push(`${i + 1}. ${ws.title} — ${ws.path}（${visibleCount} 会话）${current}`);
        }
        lines.push("", "切换: /workspace switch <编号|路径>");
        if (shown.length < workspaces.length) {
          lines.push(`显示 ${shown.length}/${workspaces.length}，看更多: /workspace list all（或 /workspace list <数量>）`);
        }
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
    this.lastSessionListByUser.delete(user.userId);
    this.clearSessionOutput(user.sessionId);
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
    return `${head}\n💬 已恢复会话: ${await this.formatSessionLabel(sessionId, path)}`;
  }

  /**
   * WeChat-facing session label: cleaned title (id prefix fallback) + full id.
   */
  private async formatSessionLabel(sessionId: string, cwd?: string): Promise<string> {
    const raw = (await this.ops.readSessionTitle(sessionId, cwd)) ?? sessionId.slice(0, 12);
    return `${cleanSessionTitle(raw)}（${sessionId}）`;
  }

  /**
   * Resolve the same recency-ordered session set for both `/s list` and
   * `/s switch`. `scope` is explicit on the command so `list current` cannot
   * accidentally be paired with the unfiltered switch list.
   *
   * Pinned sessions come first, then everything else. Each group keeps the
   * recency order, so the pin set is a *partition* marker only — the host's
   * own "most recently pinned first" array order deliberately does not drive
   * the row order, matching the GUI's 「最近更新」 view where the pin time does
   * not affect the sort. This keeps `/s list` numbers stable for unpinned
   * users (no pins = byte-identical order to before).
   */
  private async listRecentSessions(user: UserState, scope?: "current") {
    const sessions = await this.ops.listSessions();
    const scoped = scope === "current"
      ? await this.filterByCurrentCwd(sessions, user.cwd)
      : sessions;

    // Cold-start recency: avoid inspecting every complete session log. Live
    // agents / projection cache / a newest-first tail read are sufficient.
    await Promise.all(
      scoped.map(async (record) => {
        if (this.lastActivityBySession.has(record.header.id)) return;
        const time = await this.ops.lastUserMessageTime(record.header.id, record.header.cwd, record.header);
        if (time !== undefined) {
          this.boundedSet(this.lastActivityBySession, record.header.id, time, ACTIVITY_MAX_SESSIONS, "lastActivityBySession");
        }
      }),
    );

    const pinned = new Set(this.ops.pinnedSessionIds());
    return [...scoped].sort((a, b) => {
      const byPin = Number(pinned.has(b.header.id)) - Number(pinned.has(a.header.id));
      if (byPin !== 0) return byPin;
      return this.sessionActivityTime(b) - this.sessionActivityTime(a);
    });
  }

  /**
   * Resolve every distinct path through {@link canonicalPath} once.
   *
   * Callers that compare several directories at the same time (a workspace
   * roster against a session cwd against each user's cwd) share one Map
   * instead of re-resolving the same spelling per comparison.
   */
  private async canonicalizePaths(paths: Iterable<string>): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    for (const p of paths) {
      if (resolved.has(p)) continue;
      resolved.set(p, await canonicalPath(p));
    }
    return resolved;
  }

  /**
   * Sessions whose recorded cwd is the user's current directory, compared
   * through the host's canonical-path rule (see {@link canonicalPath}).
   *
   * A plain `header.cwd === user.cwd` string compare misses the same
   * directory spelled with a trailing separator, a `.` segment, or a
   * different letter case — the host's `workspaceRegistry` resolves all of
   * those to one workspace, so the WeChat side must agree with it.
   *
   * Sessions with no recorded cwd stay excluded, as before.
   */
  private async filterByCurrentCwd(
    records: SessionRecord[],
    userCwd: string,
  ): Promise<SessionRecord[]> {
    const cwds: string[] = [userCwd];
    for (const record of records) {
      const cwd = record.header.cwd;
      if (typeof cwd === "string" && cwd.length > 0) cwds.push(cwd);
    }
    const resolved = await this.canonicalizePaths(cwds);
    const target = resolved.get(userCwd);
    const out: SessionRecord[] = [];
    for (const record of records) {
      const cwd = record.header.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) continue;
      if (resolved.get(cwd) === target) out.push(record);
    }
    return out;
  }

  /**
   * Resolve a shorthand switch against the exact rows from the last list.
   * Return `undefined` when the snapshot is unavailable or no longer valid;
   * the caller then falls back to a fresh all-session list.
   */
  private async sessionsFromLastList(user: UserState) {
    const snapshot = this.lastSessionListByUser.get(user.userId);
    if (!snapshot || snapshot.sessionIds.length === 0) return undefined;
    if (snapshot.scope === "current" && snapshot.cwd !== user.cwd) return undefined;

    const current = await this.ops.listSessions();
    const byId = new Map(current.map((record) => [record.header.id, record]));
    const rows = snapshot.sessionIds
      .map((id) => byId.get(id))
      .filter((record): record is NonNullable<typeof record> => record !== undefined);
    return rows.length === snapshot.sessionIds.length ? rows : undefined;
  }

  private async handleSessionCommand(userId: string, cmd: SessionCommand): Promise<void> {
    const user = this.ensureBoundUser(userId);
    switch (cmd.kind) {
      case "list": {
        // Both display and switching use this same scoped, recency-ordered
        // source. `/s list current` advertises the explicit scoped switch
        // form so its row numbers cannot be interpreted against all sessions.
        const allRecent = await this.listRecentSessions(user, cmd.scope);
        // The snapshot keeps EVERY row, not just the displayed window: a
        // following `/s switch <n>` is validated against the full list, so
        // `/s list` then `/s switch 25` still reaches row 25 the user asked
        // for by number (the "看更多" hint is what surfaces those rows).
        this.lastSessionListByUser.set(user.userId, {
          scope: cmd.scope,
          cwd: user.cwd,
          sessionIds: allRecent.map((record) => record.header.id),
        });
        const recent = cmd.all ? allRecent : allRecent.slice(0, cmd.limit ?? LIST_DEFAULT);
        const listVerb = cmd.scope === "current" ? "/s list current" : "/s list";
        const pinnedIds = new Set(this.ops.pinnedSessionIds());
        if (recent.length === 0) {
          await this.sendReply(
            userId,
            cmd.scope === "current"
              ? `💬 当前工作目录（${user.cwd}）下暂无会话。发送消息即可创建第一个会话。`
              : "💬 暂无会话。发送消息即可创建第一个会话。",
          );
          return;
        }
        const lines = [cmd.scope === "current"
          ? `💬 最近会话（${user.cwd}，/session switch current <编号> 切换）`
          : pinnedIds.size > 0
            ? "💬 最近会话（📌 置顶优先，其余按最近活动排序，/session switch <编号> 切换）"
            : "💬 最近会话（按最近活动排序，/session switch <编号> 切换）"];
        // One log fold per displayed row (title + live preset). A second
        // `/s list` is a stat: session-log.cjs caches by (path, size, mtime).
        const [facts, presets] = await Promise.all([
          Promise.all(recent.map((r) => this.ops.readSessionListFacts(r.header.id, r.header.cwd, r.header))),
          this.ops.listPresets(),
        ]);
        for (let i = 0; i < recent.length; i++) {
          const record = recent[i]!;
          const row = facts[i];
          const marker = record.header.id === user.sessionId ? " ◀ 当前" : "";
          const pin = pinnedIds.has(record.header.id) ? "📌 " : "";
          const title = cleanSessionTitle(row?.title ?? record.header.id.slice(0, 12));
          if (row?.lastUserMessageTime !== undefined) {
            this.boundedSet(this.lastActivityBySession, record.header.id, row.lastUserMessageTime, ACTIVITY_MAX_SESSIONS, "lastActivityBySession");
          }
          const when = this.formatRelativeTime(this.sessionActivityTime(record));
          const presetId = row?.preset;
          const presetLabel = presetId
            ? (presets.find((p) => p.id === presetId)?.name ?? presetId)
            : undefined;
          // One line per entry: WeChat renders `\n` in BOT text unreliably
          // (entries collapse together), so every field rides the same line
          // and each entry stays identifiable by its `N.` prefix.
          lines.push(
            `${i + 1}. ${pin}${title}${marker} — ${record.header.cwd ?? "?"} · ${when}${presetLabel ? ` · Preset:${presetLabel}` : ""}`,
          );
        }
        if (recent.length < allRecent.length) {
          lines.push(`显示 ${recent.length}/${allRecent.length}，看更多: ${listVerb} all（或 ${listVerb} <数量>）`);
        }
        lines.push("", "置顶/取消: /s pin <编号>、/s unpin <编号>（省略编号作用于当前会话）");
        await this.sendReply(userId, lines.join("\n"));
        return;
      }
      case "switch": {
        // An explicit scope is resolved afresh. For the shorthand form, first
        // use the exact rows from the latest `/s list` (so `/s list current`
        // followed by `/s switch <n>` keeps working), then fall back to the
        // historical all-session list when no snapshot exists.
        const recent = cmd.scope !== undefined
          ? await this.listRecentSessions(user, cmd.scope)
          : (await this.sessionsFromLastList(user)) ?? await this.listRecentSessions(user);
        if (recent.length === 0) {
          await this.sendReply(
            userId,
            cmd.scope === "current"
              ? `⚠️ 当前工作目录（${user.cwd}）下暂无会话。`
              : "⚠️ 暂无可切换的会话。",
          );
          return;
        }
        const index = cmd.index;
        if (index < 1 || index > recent.length) {
          await this.sendReply(userId, `⚠️ 编号超出范围（1-${recent.length}）。`);
          return;
        }
        const record = recent[index - 1]!;
        this.lastSessionListByUser.delete(user.userId);
        this.clearSessionOutput(user.sessionId);
        user.sessionId = record.header.id;
        if (record.header.cwd) {
          user.cwd = record.header.cwd;
          user.cwdExplicit = true;
        }
        this.state.update(user.userId, { sessionId: user.sessionId, cwd: user.cwd, cwdExplicit: user.cwdExplicit });
        this.trackWatchedSession(user.userId, user.sessionId);
        // Do not replace-on-failure here: the user asked for this exact
        // session. A corrupt target stays bound so `/s new` can mint a
        // replacement instead of silently swapping ids on switch.
        const { agent } = await this.agents.ensure(user);
        const label = await this.formatSessionLabel(record.header.id, record.header.cwd);
        await this.sendReply(
          userId,
          agent
            ? `✅ 已切换到会话 ${label} — ${record.header.cwd ?? "?"}，Agent ${agent.status}。`
            : `⚠️ 已切换到会话 ${label} — ${record.header.cwd ?? "?"}，但该会话无法恢复（日志可能已损坏）。发送 /s new 新建，或换一条会话。`,
        );
        // Flush any pending cards for the session just switched into
        // (notified earlier, or silently when nothing was pending).
        await this.flushPendingCardsForSession(user.userId, user.sessionId);
        return;
      }
      case "pin":
      case "unpin": {
        await this.handlePinCommand(userId, user, cmd.kind, cmd.index);
        return;
      }
      case "new": {
        // GUI-equivalent "reuse-or-create its blank session": if the current
        // session is already blank (created but never spoken to), stay on it;
        // otherwise reuse the newest blank session in the current cwd; only
        // when none exists create a fresh one. A corrupt / unreadable log is
        // NOT blank — staying on it would lock the user out of every later
        // message (resume fails, binding never changes).
        if (user.sessionId) {
          const current = await this.ops.inspectSessionActivity(user.sessionId, user.cwd);
          if (current.ok && current.lastUserMessageTime === undefined) {
            const agent = this.agents.get(user);
            await this.sendReply(userId, `✅ 已在空白会话（${user.sessionId.slice(0, 12)}）${agent ? `，Agent ${agent.status}` : ""}。`);
            return;
          }
          if (!current.ok) {
            const brokenId = user.sessionId;
            await this.createFreshSession(user, userId, {
              success: `⚠️ 原会话 ${brokenId} 已损坏，无法恢复；已新建会话`,
            });
            return;
          }
        }
        const blank = await this.findBlankSession(user.cwd, user.sessionId);
        if (blank) {
          this.clearSessionOutput(user.sessionId);
          user.sessionId = blank;
          this.state.update(user.userId, { sessionId: user.sessionId });
          this.trackWatchedSession(user.userId, blank);
          const { agent } = await this.agents.ensure(user, { replaceOnResumeFailure: true });
          this.persistSessionBinding(user);
          if (agent && user.sessionId === blank) {
            await this.sendReply(userId, `✅ 已复用空白会话 ${blank.slice(0, 12)}（${user.cwd}），Agent ${agent.status}。`);
            return;
          }
          // Reuse target itself failed to load; ensure() already minted a
          // replacement when replaceOnResumeFailure is on.
          await this.sendReply(
            userId,
            agent
              ? `⚠️ 空白会话 ${blank} 无法恢复；已新建会话 ${user.sessionId}（${user.cwd}）。`
              : `⚠️ 空白会话 ${blank} 无法恢复，且新建会话失败。请检查 DSH 日志。`,
          );
          return;
        }
        await this.createFreshSession(user, userId);
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
   * Handle `/s pin [编号]` and `/s unpin [编号]`.
   *
   * The pin set lives in the host registry (`workspaceRegistry.pinnedSessionIds`),
   * so the GUI sidebar and WeChat read and write one durable set. Without a row
   * number the command acts on the user's currently bound session — the common
   * case, needing no list first. With one, the number resolves through the exact
   * rows of the latest `/s list` (same helper `/s switch` uses), so a number the
   * user just read always addresses the row they saw.
   *
   * Pre-checks keep the happy path off the host's exception channel: an
   * already-pinned id is a no-op (the host would also no-op), and an archived
   * session cannot be pinned at all (the host would reject). Both are reported
   * with the state the user asked about, not as a failure.
   */
  private async handlePinCommand(
    userId: string,
    user: UserState,
    kind: "pin" | "unpin",
    index: number | undefined,
  ): Promise<void> {
    let targetId: string;
    if (index === undefined) {
      if (!user.sessionId) {
        await this.sendReply(
          userId,
          `⚠️ 当前没有绑定会话。先发消息，或 /s list 后用 /s ${kind} <编号>。`,
        );
        return;
      }
      targetId = user.sessionId;
    } else {
      const recent = (await this.sessionsFromLastList(user)) ?? await this.listRecentSessions(user);
      if (index < 1 || index > recent.length) {
        await this.sendReply(userId, `⚠️ 编号超出范围（1-${recent.length}）。`);
        return;
      }
      targetId = recent[index - 1]!.header.id;
    }

    // A host without the pin API has no meaningful pin set: reading it would
    // look exactly like "nothing is pinned", so report the missing service up
    // front rather than answering from an absent set.
    if (!this.ops.supportsPin()) {
      await this.sendReply(userId, this.pinFailureText(kind, "unavailable", targetId));
      return;
    }

    const pinned = this.ops.pinnedSessionIds();
    const alreadyPinned = pinned.includes(targetId);
    if (kind === "pin" && alreadyPinned) {
      await this.sendReply(userId, `ℹ️ 该会话已置顶: ${await this.formatSessionLabel(targetId)}`);
      return;
    }
    if (kind === "unpin" && !alreadyPinned) {
      await this.sendReply(userId, `ℹ️ 该会话未置顶: ${await this.formatSessionLabel(targetId)}`);
      return;
    }
    // Archived sessions are hidden from `/s list`, so only the bound-session
    // path can reach this. Pinning and archiving are mutually exclusive in the
    // host; report it as the archive problem it is rather than a pin failure.
    if (kind === "pin" && this.ops.archivedSessionIds().includes(targetId)) {
      await this.sendReply(userId, `⚠️ 该会话已归档，无法置顶: ${targetId}`);
      return;
    }

    const outcome = kind === "pin"
      ? await this.ops.pinSession(targetId)
      : await this.ops.unpinSession(targetId);
    if (outcome !== "ok") {
      await this.sendReply(userId, this.pinFailureText(kind, outcome, targetId));
      return;
    }

    // The pin changed the row order, so refresh the snapshot a following
    // `/s switch <n>` / `/s pin <n>` resolves against — the numbers must keep
    // matching what the next `/s list` renders.
    await this.refreshSessionListSnapshot(user);

    const label = await this.formatSessionLabel(targetId);
    await this.sendReply(
      userId,
      kind === "pin" ? `📌 已置顶会话 ${label}` : `✅ 已取消置顶会话 ${label}`,
    );
  }

  /** User-facing text for a non-`ok` pin outcome. */
  private pinFailureText(kind: "pin" | "unpin", outcome: PinOutcome, sessionId: string): string {
    switch (outcome) {
      case "archived":
        return `⚠️ 该会话已归档，无法置顶: ${sessionId}`;
      case "unknown":
        return `⚠️ 找不到该会话（可能已删除）: ${sessionId}`;
      case "unavailable":
        return `⚠️ 当前 DSH 未提供会话置顶服务（workspaceRegistry 不可用），${kind === "pin" ? "置顶" : "取消置顶"}未生效。`;
      case "failed":
        return `⚠️ ${kind === "pin" ? "置顶" : "取消置顶"}失败，请检查 DSH 日志。`;
      case "ok":
        return "";
    }
  }

  /**
   * Re-store the full recency-ordered session list for the user after a pin
   * change, so the numbered snapshot stays aligned with the reordered rows.
   */
  private async refreshSessionListSnapshot(user: UserState): Promise<void> {
    const snapshot = this.lastSessionListByUser.get(user.userId);
    if (!snapshot) return;
    const scope = snapshot.scope;
    // A scoped snapshot is only valid while the user stays in that directory.
    if (scope === "current" && snapshot.cwd !== user.cwd) return;
    const allRecent = await this.listRecentSessions(user, scope);
    this.lastSessionListByUser.set(user.userId, {
      scope,
      cwd: user.cwd,
      sessionIds: allRecent.map((record) => record.header.id),
    });
  }

  /**
   * Unbind the current session and mint a fresh one via `agents.ensure`.
   * Used by `/s new` when no reusable blank exists, and when the bound
   * session's log is corrupt.
   */
  private async createFreshSession(
    user: UserState,
    userId: string,
    wording?: { success: string },
  ): Promise<void> {
    this.lastSessionListByUser.delete(user.userId);
    this.clearSessionOutput(user.sessionId);
    user.sessionId = "";
    this.state.update(user.userId, { sessionId: "" });
    const { agent } = await this.agents.ensure(user);
    this.persistSessionBinding(user);
    if (!agent) {
      await this.sendReply(userId, "⚠️ 无法创建 DSH 会话，请检查 DSH 日志。");
      return;
    }
    const head = wording?.success ?? "✅ 已创建新会话";
    await this.sendReply(userId, `${head} ${user.sessionId}（${user.cwd}），Agent 就绪。`);
  }

  /**
   * Find the newest blank (never-spoken-to) session in `cwd`, mirroring the
   * GUI's "reuse-or-create its blank session" behavior. A blank session is
   * one with no `user/message` event in its log — created by a previous
   * "new session" that the user never used. Archived sessions are already
   * filtered by `listSessions()`. Unreadable / corrupt logs are skipped
   * (they are not blank). `excludeId` skips the caller's current session
   * (the caller handles "already blank" separately).
   */
  private async findBlankSession(cwd: string, excludeId?: string): Promise<string | undefined> {
    const sessions = await this.ops.listSessions();
    const cwds: string[] = [cwd];
    for (const r of sessions) {
      const recorded = r.header.cwd;
      if (typeof recorded === "string" && recorded.length > 0) cwds.push(recorded);
    }
    // Canonical compare, like the host: a header cwd recorded before the
    // settings-page cwd changed spelling (trailing separator, case) is still
    // the same directory, so its blank session must be reused rather than
    // accumulating a new blank session per /s new.
    const resolved = await this.canonicalizePaths(cwds);
    const target = resolved.get(cwd);
    const candidates = sessions
      .filter((r) => {
        const recorded = r.header.cwd;
        return typeof recorded === "string" && recorded.length > 0
          && resolved.get(recorded) === target
          && r.header.id !== excludeId;
      })
      .sort((a, b) => b.header.createdAt - a.header.createdAt);
    for (const record of candidates) {
      const activity = await this.ops.inspectSessionActivity(record.header.id, record.header.cwd, record.header);
      if (activity.ok && activity.lastUserMessageTime === undefined) return record.header.id;
    }
    return undefined;
  }

  private async handlePresetCommand(userId: string, cmd: PresetCommand): Promise<void> {
    const user = this.ensureBoundUser(userId);
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
        if (!saved) {
          await this.sendReply(userId, `⚠️ 默认 Preset 切换失败: ${preset.name ?? preset.id}（无法写入 DSH 设置，默认 Preset 未更改）。`);
          return;
        }
        // Apply to the live session only while it has produced nothing.
        const agent = this.agents.get(user);
        const empty = agent ? sessionEvents(agent.session).length === 0 : true;
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
        await this.sendReply(userId, `✅ 默认 Preset 已切换: ${preset.name ?? preset.id}${applied}。`);
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
          ? await this.ops.resolveSessionPreset(user.sessionId, user.cwd)
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
    const user = this.ensureBoundUser(userId);
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
          this.setModelOverride(agent.id, selection);
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
            this.setModelOverride(agent.id, rest);
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
   * `/history [all] [N]` — show the most recent N conversation entries of
   * the current session (default 5, max 20). Default lists only human and
   * assistant turns; `all` also includes synthesized system injections
   * (compaction checkpoints, plugin context, goal rounds). Each entry is
   * Each entry is its own block (`角色 · 时间` then the original body),
   * oldest→newest, so it reads closer to a live WeChat message than a dump.
   */
  private async handleHistoryCommand(userId: string, cmd: HistoryCommand, user: UserState): Promise<void> {
    if (!user.sessionId) {
      await this.sendReply(userId, "💬 暂无会话，发送消息后可查看历史（/history [1-20]）");
      return;
    }
    const count = Math.max(1, Math.min(cmd.count, HISTORY_MAX));
    let entries: Array<{ role: "user" | "assistant" | "system"; text: string; time: number }>;
    try {
      entries = await this.ops.getSessionHistory(user.sessionId, count, {
        includeSystem: cmd.includeSystem,
      });
    } catch (err) {
      console.warn(`[dsh-wechat] getSessionHistory failed: ${String(err)}`);
      await this.sendReply(userId, `⚠️ 读取历史失败：${maskSecrets(String(err))}`);
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
      entries.forEach((e, i) => {
        const roleLabel =
          e.role === "user" ? "👤 你" : e.role === "system" ? "⚙️ 系统" : "🤖 助手";
        const when = e.time ? this.formatRelativeTime(e.time) : "未知时间";
        const keepFull = i === lastAssistantIdx;
        const body = keepFull
          ? e.text
          : e.text.length > HISTORY_TEXT_LIMIT
            ? e.text.slice(0, HISTORY_TEXT_LIMIT - 1) + "…"
            : e.text;
        lines.push(`${roleLabel} · ${when}\n${body.trimEnd()}`);
      });
      lines.push(`提示: /history all 含系统消息；/history [1-${HISTORY_MAX}] 换条数（默认 5）`);
      await this.sendReply(userId, lines.join("\n\n"));
    }
    await this.resendPendingCardsForHistory(userId);
  }

  /** After `/history`, re-send every still-answerable card in full. */
  private async resendPendingCardsForHistory(userId: string): Promise<void> {
    const approvals = this.answerableApprovals(userId);
    const questions = this.answerableQuestions(userId);
    if (approvals.length === 0 && questions.length === 0) return;
    const sessions = new Set([...approvals, ...questions].map((c) => c.sessionId)).size;
    const scope = sessions > 1 ? "（可能跨会话）" : "";
    await this.sendReply(userId, `⏳ 当前有 ${approvals.length + questions.length} 张待处理卡片${scope}，完整内容如下（直接回复即可，多卡请用 P{n}=… 指定编号）：`);
    for (const card of approvals) {
      await this.sendApprovalCard(userId, card);
    }
    for (const card of questions) {
      await this.sendQuestionCard(userId, card, card.items);
    }
  }

  private async handleModelCommand(userId: string, cmd: ModelCommand): Promise<void> {
    const user = this.ensureBoundUser(userId);
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
        const target = cmd.target.trim();
        if (!target) {
          await this.sendReply(
            userId,
            "⚠️ 用法: /model switch <提供商>/<模型id>。模型 id 可含 /，例如 /model switch openrouter/inclusionai/foo:free",
          );
          return;
        }
        const providers = this.ops.listProviders();
        const split = splitProviderModelTarget(target, providers);
        if (!split) {
          const hint = providers.map((p) => p.id).join(", ") || "(无)";
          if (!target.includes("/")) {
            await this.sendReply(
              userId,
              `⚠️ 用法: /model switch <提供商>/<模型id>。可用提供商: ${hint}`,
            );
          } else {
            await this.sendReply(
              userId,
              `⚠️ 未知提供商: ${target.slice(0, target.indexOf("/"))}。可用: ${hint}`,
            );
          }
          return;
        }
        const matchedProvider = providers.find((p) => p.id === split.provider);
        if (!matchedProvider) {
          await this.sendReply(userId, `⚠️ 未知提供商: ${split.provider}。可用: ${providers.map((p) => p.id).join(", ")}`);
          return;
        }
        const models = await this.ops.listModels(matchedProvider.id);
        const matchedModel = models.find((m) => m.id === split.model || m.name === split.model);
        if (!matchedModel) {
          await this.sendReply(userId, `⚠️ 未知模型: ${split.model}。用 /model list ${matchedProvider.id} 查看可用模型。`);
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
          this.setModelOverride(agent.id, selection);
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
    const user = this.ensureBoundUser(userId);
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
          await this.sendReply(userId, `⚠️ 切换权限失败: ${maskSecrets(String(err))}`);
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
        // S1: the default is GLOBAL and PERSISTENT — it is written into the
        // `permission` settings document and applies to every session this
        // DSH install creates from now on, WeChat-related or not. A chat
        // message proving possession of a WeChat account must therefore not be
        // able to raise it; a de-escalating write is still allowed.
        if (!this.config.allowRemotePermissionEscalation && this.isEscalatingPreset(service, name)) {
          this.audit.record({
            event: "perm-default-refused",
            user: maskUserId(userId),
            preset: name,
            reason: "escalation",
          });
          await this.sendReply(
            userId,
            [
              `⛔ 已拒绝：${this.describePermission(service, name)} 会放宽**全局**默认权限。`,
              "该默认值写入 DSH 设置，对所有新会话生效（与微信无关），属于提权操作，只能在本机界面完成。",
              "请打开 DSH 界面 → 设置 → 权限（Permission）→ 默认预设，选择该预设并保存。",
              "会话级切换不受影响：/perm switch <名称> 只作用于当前会话。",
              "如确实需要微信端修改全局默认，请在设置页开启「允许微信放宽全局默认权限」（配置键 allowRemotePermissionEscalation）。",
            ].join("\n"),
          );
          return;
        }
        const saved = await this.ops.saveDefaultPermission(name);
        this.audit.record({
          event: "perm-default-set",
          user: maskUserId(userId),
          preset: name,
          ...(this.config.allowRemotePermissionEscalation ? { via: "allowRemotePermissionEscalation" } : {}),
        });
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

  /**
   * `current()` with a guard. The host reads the Session's `permissions`
   * projection (`current(session: Session)`), so the live Session must be
   * passed; a session without that projection still degrades to `undefined`.
   */
  private safeCurrent(
    service: { current(session: unknown): string },
    agent: Agent,
  ): string | undefined {
    try {
      return service.current(agent.session);
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
   * Whether a preset is an ESCALATION, read from the same knob bundle the
   * host applies (`permissionPresets.resolve(name)` → `{ sandbox, approval }`,
   * the schema of `@deepseek-ai/dsh-permission-presets`):
   *
   *   - `sandbox === "danger-full-access"` — no filesystem confinement, or
   *   - `approval === "never"` — no approval prompt will ever be shown,
   *     regardless of what the sandbox refuses.
   *
   * Both knobs are read on purpose: the host ships `danger-full-access` as
   * `{sandbox: danger-full-access, approval: never}` and `auto` as
   * `{sandbox: danger-full-access, approval: ask}`, so keying on the sandbox
   * alone would miss a config-declared preset that only drops approvals.
   *
   * A preset whose bundle cannot be resolved counts as escalating: an
   * unreadable knob bundle must not be written globally just because we could
   * not prove it is dangerous.
   */
  private isEscalatingPreset(
    service: { resolve(name: string): { sandbox: string; approval: string } },
    name: string,
  ): boolean {
    try {
      const spec = service.resolve(name);
      return spec.sandbox === "danger-full-access" || spec.approval === "never";
    } catch {
      return true;
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
   * Record one session's model override under a hard FIFO cap.
   *
   * The map is keyed by session id and nothing ever removed an entry, so a
   * long-lived install with many sessions kept every override alive for the
   * process lifetime. The cap bounds it; eviction is deterministic (oldest
   * written first) and only affects sessions that have not had `/model` or
   * `/reasoning` touched in the last {@link MODEL_OVERRIDE_MAX_SESSIONS}
   * writes — for those, the model falls back to the persisted default, which
   * `/model switch` writes in the same breath.
   */
  private setModelOverride(agentId: string, override: ModelOverride): void {
    this.boundedSet(this.modelOverrides, agentId, override, MODEL_OVERRIDE_MAX_SESSIONS, "modelOverrides");
  }

  /**
   * Color marker for boolean toggles on /status. Each field has its own
   * semantic — `on` for 静默模式 means "we stop forwarding to WeChat"
   * (warning), `on` for 跨会话决策推送 means "extra delivery is enabled"
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
      ? (await this.ops.readSessionTitle(user.sessionId, user.cwd)) ?? user.sessionId.slice(0, 12)
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
    const pendingLines = this.formatPendingStatusLines(user.userId);
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
      ...pendingLines,
      presetLines.sessionLine,
      `• 模型: ${active?.provider && active?.model ? `${active.provider}/${active.model}${effortSuffix}` : "（默认）"}`,
      ...(contextLabel ? [contextLabel] : []),
      ...(permission
        ? [`• 权限: ${permission.startsWith("danger") ? this.paintBadge(permission, "warning") : permission}`]
        : []),
      presetLines.defaultLine,
      // 静默模式 on = we stop forwarding (warning); off = normal delivery (good).
      `• 静默模式: ${this.paintBadge(this.isSilent() ? "on" : "off", this.isSilent() ? "warning" : "positive")}`,
      // 结论模式 on = per-task hold, only the final conclusion is pushed (good).
      ...(this.finalOnlyEnabled()
        ? [`• 结论模式: ${this.paintBadge(`on（暂存 ${this.pendingFinal.size}）`, "positive")}`]
        : [`• 结论模式: ${this.paintBadge("off", "neutral")}`]),
      `• 微信提示词: ${this.paintBadge(this.config.surfacePromptEnabled ? "on" : "off", this.config.surfacePromptEnabled ? "positive" : "neutral")}`,
      `• 繁忙投递: ${this.ops.busyEnter() === "steer" ? this.paintBadge("steer（插话）", "positive") : this.paintBadge("queue（排队）", "neutral")}`,
      // 打字合并 (F1) — shows the live parameters AND the buffered count, so
      // the window is never a black box the user has to guess about.
      `• 打字合并: ${this.mergeEnabled() ? this.paintBadge(this.mergeStatusText(), "positive") : this.paintBadge("off", "neutral")}`,
      // Inbound allowlist (S3): the owner's own id is printed in full here — on
      // purpose, because "never require the user to know their own id" — while
      // logs only ever carry the masked form.
      `• 入站白名单: ${this.describeAllowlist(user.userId)}`,
      // Audit trail location: the trail exists for the operator, who has to be
      // able to find it without reading the source.
      `• 审计日志: ${this.audit.path()}（按 1 MiB 轮转为 .1）`,
      // 跨会话决策推送 on = extra delivery enabled (good); off = quiet (neutral).
      `• 跨会话决策推送: ${this.paintBadge(crossEffective, crossEffective === "on" ? "positive" : "neutral")}`,
      `• 跨会话任务完成提醒: ${this.paintBadge(this.notifyTaskEventsEnabled() ? "on" : "off", this.notifyTaskEventsEnabled() ? "positive" : "neutral")}`,
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

  /**
   * `/status` inbound-allowlist row (S3). When the list is empty the row says
   * so explicitly — "first contact wins" is a security-relevant state and must
   * be visible; when it is set, the bound peer's OWN id is printed in full so
   * the owner never has to discover their id elsewhere to edit the list.
   */
  private describeAllowlist(ownUserId: string): string {
    const allowed = this.config.allowedUsers;
    if (allowed.length === 0) {
      return this.paintBadge("关（首位给你发消息的人会成为绑定对端）", "warning");
    }
    const own = allowed.includes(ownUserId) ? " ◀ 当前绑定" : "";
    return `${allowed.join(", ")}${own}（其他人发消息会被忽略，不回复）`;
  }

  /** `/status` rows for unanswered cards, split into current vs other sessions. */
  private formatPendingStatusLines(userId: string): string[] {
    const currentId = this.state.getUser(userId)?.sessionId;
    const approvals = this.pendingApprovals.get(userId) ?? [];
    const questions = this.pendingQuestions.get(userId) ?? [];
    const currentA = currentId ? approvals.filter((c) => c.sessionId === currentId) : [];
    const currentQ = currentId ? questions.filter((c) => c.sessionId === currentId) : [];
    const crossA = currentId ? approvals.filter((c) => c.sessionId !== currentId) : approvals;
    const crossQ = currentId ? questions.filter((c) => c.sessionId !== currentId) : questions;
    const lines: string[] = [];
    const current = this.formatPendingParts(currentQ.length, currentA.length);
    if (current) lines.push(`🔴 • 待处理(当前): ${current}`);
    const cross = this.formatPendingParts(crossQ.length, crossA.length);
    if (cross) {
      const hint = this.shouldNotifyCrossSession(userId) ? "用 P{n}= 回复" : "/session switch 后查看";
      lines.push(`🔴 • 待处理(跨会话): ${cross}（${hint}）`);
    }
    return lines;
  }

  private formatPendingParts(questions: number, approvals: number): string | undefined {
    const parts: string[] = [];
    if (questions > 0) parts.push(`${questions} 张提问卡`);
    if (approvals > 0) parts.push(`${approvals} 张权限卡`);
    return parts.length > 0 ? parts.join(" · ") : undefined;
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
    const liveId = await this.ops.resolveSessionPreset(user.sessionId, user.cwd);
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

  /** Effective outgoing-file size ceiling (bytes); malformed config falls back to the default. */
  private maxOutgoingFileBytes(): number {
    const value = this.config.maxOutgoingFileBytes;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : defaultConfig().maxOutgoingFileBytes;
  }

  /** Size of a file in bytes, or undefined when it cannot be stat'ed. */
  private async outgoingFileSize(filePath: string): Promise<number | undefined> {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile() ? stat.size : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Roots an outgoing file may live under: the working directory of the
   * session that is ACTUALLY sending, plus every registered workspace.
   *
   * The sender is resolved from the calling agent id — never from the
   * recipient fallback. Those are different questions: an unbound (GUI)
   * session still sends to the first known WeChat user, and the file bound
   * must be the CALLER's, otherwise any session could read any other
   * session's workspace by relying on the recipient fallback.
   */
  private async outgoingFileRoots(senderAgentId: string): Promise<string[]> {
    const roots = new Set<string>();
    if (senderAgentId) {
      try {
        const live = this.ctx.get<{ get(id: string): Agent | undefined }>("agents")?.get(senderAgentId);
        const liveCwd = live?.session?.header?.cwd;
        if (typeof liveCwd === "string" && liveCwd) roots.add(liveCwd);
      } catch {
        // A host without the live header simply falls through to the roster.
      }
      const record = await this.ops.findSessionRecord(senderAgentId);
      if (record?.header.cwd) roots.add(record.header.cwd);
      const bound = this.userForAgent(senderAgentId);
      if (bound?.cwd) roots.add(bound.cwd);
    }
    for (const workspace of this.ops.listWorkspaces()) {
      if (workspace.path) roots.add(workspace.path);
    }
    return [...roots];
  }

  /**
   * Validate one `send_wechat` file: it must exist, be a regular file, fit in
   * {@link maxOutgoingFileBytes}, and — unless `allowAnyFilePath` is set —
   * resolve inside one of {@link outgoingFileRoots}.
   *
   * @returns `undefined` when the file may be sent, else the refusal message
   *   the tool returns verbatim.
   */
  private async guardOutgoingFile(senderAgentId: string, filePath: string): Promise<string | undefined> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return `file not found: ${filePath}`;
    }
    if (!stat.isFile()) return `not a regular file: ${filePath}`;
    const max = this.maxOutgoingFileBytes();
    if (stat.size > max) {
      return `file too large: ${filePath} is ${stat.size} bytes (limit ${max}; raise maxOutgoingFileBytes in the plugin settings)`;
    }
    if (this.config.allowAnyFilePath) return undefined;
    // Canonicalize BOTH sides: a symlink inside the workspace pointing at
    // /etc/shadow must not pass, and `..` must not escape.
    const target = await canonicalPath(filePath);
    const roots = await this.outgoingFileRoots(senderAgentId);
    for (const root of roots) {
      const canonicalRoot = await canonicalPath(root);
      if (isPathInside(canonicalRoot, target)) return undefined;
    }
    const where = roots.length > 0 ? roots.join(", ") : "(no session cwd and no registered workspace)";
    return (
      `refused: ${filePath} is outside the calling session's workspace. `
      + `Allowed roots: ${where}. Move the file there, or set allowAnyFilePath=true in the plugin settings to allow any path.`
    );
  }

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
   *
   * S2: `file_path` is NOT an arbitrary-file-read primitive. The path is
   * validated against the sending session's workspace (and every registered
   * workspace) with a size ceiling before anything is read or queued; the
   * check happens against the CALLER, not against the recipient fallback, so
   * an unbound session cannot borrow another session's roots.
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

    // Rate limit BEFORE the send. This is the agent-initiated path only —
    // assistant replies are the user's own answer and must never be gated
    // here. Refusing loudly (ok:false) is the point: a silent send would let
    // a loop keep pushing until WeChat's 10-message window is spent on
    // narration, and the model would never learn to stop.
    const limitPerMinute = this.config.sendWechatRateLimitPerMinute;
    if (!this.pushRate.accept(limitPerMinute)) {
      const waitSeconds = this.pushRate.retryAfterSeconds();
      this.log(`send_wechat refused: ${this.pushRate.count()} push(es) in the last minute (limit ${limitPerMinute})`);
      return {
        ok: false,
        message:
          `rate limited: ${this.pushRate.count()} send_wechat push(es) in the last 60s (limit ${limitPerMinute}/min). `
          + `Do NOT keep pushing — finish the task and put the result in your normal reply`
          + (waitSeconds > 0 ? `; the next push is accepted in ~${waitSeconds}s` : "")
          + ".",
      };
    }

    if (args.file_path) {
      const filePath = args.file_path;
      const fileName = filePath.split(/[\\/]/).pop() ?? "file";
      // S2: validate BEFORE reading/queueing anything. The bound is evaluated
      // against the CALLING session (`agentId`), not against the recipient
      // fallback resolved above.
      const refusal = await this.guardOutgoingFile(agentId, filePath);
      if (refusal) {
        this.log(`send_wechat file refused: ${refusal}`);
        this.audit.record({
          event: "send_wechat-file",
          user: maskUserId(user.userId),
          sender: maskUserId(agentId),
          path: filePath,
          result: "refused",
        });
        return { ok: false, message: refusal };
      }
      this.audit.record({
        event: "send_wechat-file",
        user: maskUserId(user.userId),
        sender: maskUserId(agentId),
        path: filePath,
        result: "allowed",
      });
      // Send images/videos with their native media type so WeChat renders
      // them inline; everything else goes as a file attachment.
      const mediaType = mediaTypeForFile(fileName);
      const kind = mediaType === UploadMediaType.IMAGE ? "image" : mediaType === UploadMediaType.VIDEO ? "video" : "file";
      const outcome = await this.deliverOutbound(user.userId, { kind: "file", filePath, fileName });
      if (outcome === "failed") {
        if (this.tokenGiveUp) {
          return { ok: false, message: "WeChat bot token is invalid; re-scan the QR code" };
        }
        // Distinguish "grew past the cap between the guard and the read" from
        // a genuinely unreadable path — the log line is precise, the tool
        // result should be too.
        const size = await this.outgoingFileSize(filePath);
        const max = this.maxOutgoingFileBytes();
        if (size !== undefined && size > max) {
          return { ok: false, message: `file too large: ${filePath} is ${size} bytes (limit ${max}; raise maxOutgoingFileBytes in the plugin settings)` };
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
  private deliverOutbound(
    userId: string,
    item: CachedMessage,
    opts?: { parkOnError?: boolean },
  ): Promise<"sent" | "cached" | "failed"> {
    const generation = this.outboundGeneration;
    return this.serializeOutbound(() => generation !== this.outboundGeneration
      ? Promise.resolve("failed" as const)
      : this.deliverOutboundLocked(userId, item, opts));
  }

  /**
   * One outbound attempt, audited. Split from the body so EVERY caller —
   * `deliverOutbound`, `sendReply`'s batch and `flushPendingLocked` — records
   * exactly one line per attempt without sprinkling audit calls over a dozen
   * early returns. Body contents are never recorded: kind, size and outcome
   * only.
   */
  private async deliverOutboundLocked(
    userId: string,
    item: CachedMessage,
    opts?: { parkOnError?: boolean },
  ): Promise<"sent" | "cached" | "failed"> {
    const outcome = await this.deliverOutboundLockedBody(userId, item, opts);
    this.audit.record({
      event: "outbound",
      user: maskUserId(userId),
      kind: item.kind,
      ...(item.kind === "text" ? { chars: item.text.length } : { file: item.fileName }),
      result: outcome,
      ...(outcome === "sent" ? { windowCount: this.wechatMsgCount } : {}),
      ...(outcome === "cached" ? { queueLength: this.outboundCache.length } : {}),
    });
    return outcome;
  }

  private async deliverOutboundLockedBody(
    userId: string,
    item: CachedMessage,
    opts?: { parkOnError?: boolean },
  ): Promise<"sent" | "cached" | "failed"> {
    const parkOnError = opts?.parkOnError !== false;
    const token = this.token;
    const generation = this.outboundGeneration;
    if (!token || this.tokenGiveUp) {
      this.logDropOutbound(item.kind === "text" ? item.text.slice(0, 60) : item.fileName);
      return "failed";
    }
    if (this.tokenInvalid) {
      this.logDropOutbound(item.kind === "text" ? item.text.slice(0, 60) : item.fileName);
      if (!parkOnError) return "failed";
      await this.parkOutbound(userId, item);
      return "cached";
    }

    // Validate file paths before consuming budget or poisoning the durable queue.
    let buffer: Buffer | undefined;
    if (item.kind === "file") {
      // Size ceiling at the READ site too, not only at the tool entry: a
      // cached item outlives restarts (state.json) and a file can grow after
      // it was queued. `stat` before `readFile` so an oversized file is never
      // pulled into memory at all.
      const size = await this.outgoingFileSize(item.filePath);
      const max = this.maxOutgoingFileBytes();
      if (size !== undefined && size > max) {
        this.log(`drop outbound file (${size} bytes > ${max} limit): ${item.fileName}`);
        return "failed";
      }
      try {
        buffer = await fs.promises.readFile(item.filePath);
      } catch (err) {
        this.log(`outbound file read failed (${item.filePath}): ${String(err)}`);
        return "failed";
      }
    }

    if (generation !== this.outboundGeneration) return "failed";
    // Payloads behind a failed / rate-limited item must not overtake it.
    if (parkOnError && this.outboundCache.length > 0) {
      await this.parkOutbound(userId, item);
      return "cached";
    }
    const count = this.wechatMsgCount;
    if (count >= MSG_LIMIT_MAX) {
      if (!parkOnError) return "failed";
      await this.parkOutbound(userId, item);
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
      if (generation !== this.outboundGeneration) return "failed";
      if (isMessageLimitError(err)) {
        this.wechatMsgCount = MSG_LIMIT_MAX;
        if (!parkOnError) return "failed";
        await this.parkOutbound(userId, item);
        return "cached";
      }
      if (isInvalidRequestError(err)) {
        this.log(`drop outbound (invalid request, not queued): ${item.kind === "text" ? item.text.slice(0, 60) : item.fileName}`);
        return "failed";
      }
      if (isSessionTimeoutError(err)) {
        this.markTokenInvalid();
        this.logDropOutbound(item.kind === "text" ? item.text.slice(0, 60) : item.fileName);
        if (!parkOnError) return "failed";
        await this.parkOutbound(userId, item);
        return "cached";
      }
      // Logout/re-login may abort an in-flight send. Never carry that text
      // across identities; every other delivery error is parked.
      if (!this.token || this.tokenGiveUp) {
        this.logDropOutbound(item.kind === "text" ? item.text.slice(0, 60) : item.fileName);
        return "failed";
      }
      if (!parkOnError) {
        this.log(`drop outbound (control reply, not queued): ${item.kind === "text" ? item.text.slice(0, 60) : item.fileName}`);
        return "failed";
      }
      await this.parkOutbound(userId, item);
      await this.notifyCachePendingLocked(userId);
      return "cached";
    }
  }

  /**
   * Append to the one durable FIFO. At the soft cap the oldest item is
   * FORCE-SENT instead of dropped; at the hard ceiling it is dropped with a
   * loud log, because that ceiling is what actually bounds memory.
   *
   * The cap exists to bound memory, but the queue's contents are exactly
   * what must not vanish: notifications, task conclusions, tool pushes. So
   * reaching the cap means "try harder", not "discard": one item leaves the
   * queue by being delivered. The only way it is still lost is if that send
   * itself fails, and `deliverOutboundLocked` then appends it again (there
   * is room, one slot was just freed) so nothing is destroyed silently.
   *
   * A force-send that keeps failing, however, frees nothing: the queue would
   * otherwise grow for the whole outage, taking `state.json` with it. The
   * hard ceiling is where the oldest item is sacrificed instead, so the
   * "never silently drop" promise degrades to "never *silently* drop" rather
   * than to an unbounded process.
   */
  private async parkOutbound(userId: string, item: CachedMessage): Promise<void> {
    // `capFlushActive` breaks the reentrancy: a failed force-send parks its
    // item again, and without the flag that park would ask for another
    // force-send, which fails again — an unbounded loop that never returns
    // to the caller waiting on `deliverOutbound`.
    if (this.outboundCache.length >= MAX_OUTBOUND_QUEUE && !this.capFlushActive) {
      const oldest = this.outboundCache[0];
      const label = oldest === undefined
        ? "(none)"
        : oldest.kind === "text" ? oldest.text.slice(0, 60) : oldest.fileName;
      // One line per force-send would flood the log when the queue sits at
      // the cap for a long time; report first entry and then every 50th.
      if (this.capFlushes === 0 || this.capFlushes % 50 === 0) {
        this.log(`outbound cache cap (${MAX_OUTBOUND_QUEUE}) reached; force-sending oldest instead of dropping it: ${label}${this.capFlushes > 0 ? ` (${this.capFlushes} force-sent so far)` : ""}`);
      }
      this.capFlushes++;
      this.capFlushActive = true;
      try {
        // MUST be the locked variant: `parkOutbound` only ever runs inside
        // `deliverOutboundLocked`, which already holds the `serializeOutbound`
        // slot. Calling the public `flushPending` here would queue this work
        // behind the operation that is awaiting it — a self-deadlock that
        // wedges the whole outbound chain (every later send, unrelated ones
        // included, never settles).
        await this.flushPendingLocked(userId, { silent: true, force: true });
      } finally {
        this.capFlushActive = false;
      }
    }
    // Hard ceiling: the force-send above could not free a slot (the outage is
    // still in effect), so drop the oldest — explicitly, not silently.
    while (this.outboundCache.length >= MAX_OUTBOUND_QUEUE_HARD) {
      const evicted = this.outboundCache.shift();
      if (evicted === undefined) break;
      this.log(`outbound cache hard ceiling (${MAX_OUTBOUND_QUEUE_HARD}) reached; dropping oldest to bound memory: ${evicted.kind === "text" ? evicted.text.slice(0, 60) : evicted.fileName}`);
    }
    this.outboundCache.push({ ...item });
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

  private async sendReply(userId: string, text: string, opts?: { parkOnError?: boolean; plainText?: boolean }): Promise<void> {
    if (!this.token || this.tokenGiveUp) {
      this.logDropOutbound(text.slice(0, 60));
      return;
    }
    const formatted = opts?.plainText ? text.trim() : formatForWeChat(text);
    if (!formatted) return;
    const segments = splitText(formatted, this.config.textChunkLimit);
    const generation = this.outboundGeneration;
    // One batch reserves all segments in order before a later reply can enter.
    await this.serializeOutbound(async () => {
      for (const segment of segments) {
        if (generation !== this.outboundGeneration) return;
        await this.deliverOutboundLocked(userId, { kind: "text", text: segment }, opts);
      }
    });
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
  private flushPending(userId: string, opts?: { silent?: boolean; force?: boolean }): Promise<void> {
    return this.serializeOutbound(() => this.flushPendingLocked(userId, opts));
  }

  private async flushPendingLocked(userId: string, opts?: { silent?: boolean; force?: boolean }): Promise<void> {
    if (this.outboundCache.length === 0) {
      if (!opts?.silent) {
        await this.deliverOutboundLocked(userId, { kind: "text", text: "✅ 没有缓存的消息。" }, { parkOnError: false });
      }
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
      if (!this.token || this.tokenGiveUp || this.tokenInvalid) break;
      // `force` (the cap-pressure flush) sends exactly ONE item past the
      // closed 10-message window: dropping is the one outcome the cap must
      // never produce, and the gateway is the authority on whether the
      // window is really closed. Bounded to the first iteration so a park
      // does not drain the whole 100-item cache into a closed window.
      const forced = opts?.force === true && index === 0;
      if (this.wechatMsgCount >= MSG_LIMIT_MAX && !forced) break;
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
          const size = await this.outgoingFileSize(msg.filePath);
          const max = this.maxOutgoingFileBytes();
          if (size !== undefined && size > max) {
            this.log(`flush dropping oversized cached file (${size} bytes > ${max} limit): ${msg.fileName}`);
            dropped++;
            this.outboundCache.shift();
            this.persistOutboundState(userId);
            continue;
          }
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
        if (isInvalidRequestError(err)) {
          this.log(`flush dropping invalid cached ${msg.kind === "text" ? "text" : msg.fileName}`);
          dropped++;
          this.outboundCache.shift();
          this.persistOutboundState(userId);
          continue;
        }
        if (isMessageLimitError(err)) this.wechatMsgCount = MSG_LIMIT_MAX;
        if (isSessionTimeoutError(err)) this.markTokenInvalid();
        break;
      }
    }

    const remaining = this.outboundCache;
    this.persistOutboundState(userId);
    const dropSuffix = dropped > 0 ? `，${dropped} 条无法投递的缓存已丢弃` : "";
    if (remaining.length > 0) {
      this.log(`flush leftover ${remaining.length} item(s) for ${userId} (sent ${sentCount})`);
      if (!opts?.silent && this.wechatMsgCount < MSG_LIMIT_MAX) {
        await this.deliverOutboundLocked(
          userId,
          { kind: "text", text: `✅ 已发送 ${sentCount} 条，剩余 ${remaining.length} 条缓存，/next 继续。${dropSuffix}` },
          { parkOnError: false },
        );
      }
    } else {
      this.log(`flush completed ${sentCount} item(s) for ${userId}${dropSuffix}`);
      if (!opts?.silent && this.wechatMsgCount < MSG_LIMIT_MAX) {
        await this.deliverOutboundLocked(
          userId,
          { kind: "text", text: `✅ 全部 ${sentCount} 条缓存消息已发送${dropSuffix}。` },
          { parkOnError: false },
        );
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
 * Canonicalize a directory path with the host's exact canon: the
 * `@deepseek-ai/dsh-workspace` paths module does
 * `import { mkdir, realpath, stat } from "node:fs/promises"` and its
 * `realpathNormalize` is `await realpath(path)`. `fs.promises.realpath` is
 * the native-backed flavor, so this resolves trailing separators, `.` /
 * `..` segments, mixed `/` `\` separators, symlinks AND letter case — the
 * same normalization that decides workspace membership and session
 * accounting on the host side. WeChat lists therefore group identically to
 * the GUI sidebar.
 *
 * Note this is deliberately NOT the callback/`realpathSync` flavor, which
 * on Windows preserves the caller's letter case and would make
 * `C:\Work` and `c:\work` compare as two different directories while the
 * host treats them as one.
 *
 * When the path cannot be resolved (a deleted/moved directory, which a
 * registered workspace can point at), fall back to `path.resolve`, which
 * still folds separators and `.`/`..` without touching the filesystem.
 */
async function canonicalPath(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Whether `target` is `root` itself or lives beneath it. Both paths are
 * expected to be canonical (see {@link canonicalPath}); the comparison is
 * segment-aware through `path.relative`, so `/work-evil` is NOT considered
 * inside `/work` and a sibling `..` escape is rejected. `relative` returning
 * an absolute path (different Windows drive) also fails the check.
 */
function isPathInside(root: string, target: string): boolean {
  if (!root || !target) return false;
  const rel = path.relative(root, target);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
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
