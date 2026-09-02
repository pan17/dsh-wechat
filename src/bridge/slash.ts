/**
 * WeChat slash-command parsers.
 *
 * Ported and trimmed from wechat-opencode (MIT) —
 * https://github.com/pan17/wechat-opencode (src/adapter/workspace-cmd.ts).
 * Only the commands the DSH bridge handles itself are kept: DSH owns
 * workspace/session/agent/model management in its GUI, so those commands
 * are intentionally absent here.
 */

export type HelpCommand = { kind: "help" };
export type StatusCommand = { kind: "status" };
export type SilentCommand = { kind: "silent"; mode: "on" | "off" | "status" };
export type StopCommand = { kind: "stop" };
export type RejectQuestionCommand = { kind: "reject-question" };
export type RejectPermissionCommand = { kind: "reject-permission" };
export type NotifyCommand =
  | { kind: "status" }
  | { kind: "on" }
  | { kind: "off" };

export type SlashCommand =
  | HelpCommand
  | StatusCommand
  | SilentCommand
  | StopCommand
  | RejectQuestionCommand
  | RejectPermissionCommand;

/** Parse `/help` (aliases `/h`, `/?`). */
export function parseHelpCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed === "/help" || trimmed === "/h" || trimmed === "/?";
}

/** Parse `/status`. */
export function parseStatusCommand(text: string): StatusCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/status") return { kind: "status" };
  return null;
}

/**
 * Parse `/silent` (alias `/sl`) — query or toggle silent mode.
 * Bare command defaults to status.
 */
export function parseSilentCommand(text: string): SilentCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/silent" || trimmed === "/sl") {
    return { kind: "silent", mode: "status" };
  }
  const m = trimmed.match(/^\/(?:silent|sl)\s+(on|off|status)\s*$/);
  if (!m) return null;
  return { kind: "silent", mode: m[1] as "on" | "off" | "status" };
}

/** Parse `/stop`. */
export function parseStopCommand(text: string): StopCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/stop") return { kind: "stop" };
  return null;
}

/**
 * Parse `/notify` (aliases `/watch`, `/notice`) — cross-session notification toggle.
 *   /notify          → status
 *   /notify status   → status
 *   /notify on|off   → on/off (also enable/disable)
 */
export function parseNotifyCommand(text: string): NotifyCommand | null {
  const trimmed = text.trim().toLowerCase();
  const m = trimmed.match(/^\/(?:notify|watch|notice)(?:\s+(.*))?$/);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (!rest || rest === "status") return { kind: "status" };
  if (rest === "on" || rest === "enable" || rest === "enabled") return { kind: "on" };
  if (rest === "off" || rest === "disable" || rest === "disabled") return { kind: "off" };
  return null;
}

/**
 * Parse `/next` — the explicit continuation for outbound messages cached by
 * the WeChat per-window send limit (the limit notices tell the user to send
 * this). Any ordinary user message also auto-flushes the cache, but `/next`
 * is recognized so it is not mistaken for an unknown command and forwarded.
 */
export function parseNextCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/next";
}

/** Parse `/reject-question` (alias `/rq`). */
export function parseRejectQuestionCommand(text: string): RejectQuestionCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/reject-question" || trimmed === "/rq") {
    return { kind: "reject-question" };
  }
  return null;
}

/** Parse `/reject-permission` (alias `/rp`). */
export function parseRejectPermissionCommand(text: string): RejectPermissionCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/reject-permission" || trimmed === "/rp") {
    return { kind: "reject-permission" };
  }
  return null;
}

/** Detect an unknown leading-slash command for the hint reply. */
export function detectUnknownSlashCommand(text: string): string | null {
  const m = text.trim().match(/^\/[a-zA-Z][a-zA-Z0-9-]*/);
  return m ? m[0] : null;
}

/**
 * Parse just the lowercase command name out of a leading-slash line.
 *
 * Mirrors the wire contract of `@deepseek-ai/dsh-commands.parseCommand`:
 * a slash at byte zero, a lowercase name containing letters, digits, `_`,
 * or `-`, followed by either end-of-input or whitespace. Anything that
 * survives the name is the handler's `rawInput` (separator whitespace
 * included — handlers own their own grammar).
 *
 * Returns `null` for: empty input, missing leading slash, name starting
 * with a digit, uppercase letters, or any other shape the registry
 * itself would reject. Callers use the result to look up a definition
 * with `ctx.commands.find(agent, name)` before deciding whether to
 * dispatch natively or fall through to forwarding.
 *
 * @param text The raw inbound WeChat text (untrimmed — leading whitespace
 *   is rejected so an accidental " /plan off" never matches).
 * @returns The lowercase command name, or `null` if the line is not a
 *   recognized native-command shape.
 */
export function parseCommandName(text: string): string | null {
  if (!text) return null;
  if (text.charCodeAt(0) !== 0x2f /* "/" */) return null;
  // The first name character must be a lowercase letter or `_`; digits
  // and `-` are not allowed at the head. This rejects "/1foo" and "-"
  // while keeping "_foo" valid (per the registry contract).
  const head = text.charCodeAt(1);
  const isHead =
    (head >= 0x61 /* "a" */ && head <= 0x7a /* "z" */) || head === 0x5f /* "_" */;
  if (!isHead) return null;
  let i = 1;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    const ok =
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x30 /* "0" */ && c <= 0x39 /* "9" */) ||
      c === 0x5f /* "_" */ ||
      c === 0x2d /* "-" */;
    if (!ok) break;
    i++;
  }
  // The byte after the name must be either EOL or ASCII whitespace.
  if (i < text.length) {
    const c = text.charCodeAt(i);
    const ws =
      c === 0x20 /* " " */ ||
      c === 0x09 /* "\t" */ ||
      c === 0x0a /* "\n" */ ||
      c === 0x0d /* "\r" */;
    if (!ws) return null;
  }
  return text.slice(1, i);
}

// ─── Workspace / Session / Agent / Model ───

export type WorkspaceCommand =
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "switch"; target: string }
  | { kind: "add"; path: string };

export type SessionCommand =
  | { kind: "list"; scope?: "current" }
  | { kind: "switch"; index: number }
  | { kind: "new" }
  | { kind: "status" };

export type PresetCommand =
  | { kind: "list" }
  | { kind: "switch"; target: string }
  | { kind: "status" };

export type ModelCommand =
  | { kind: "list"; provider?: string }
  | { kind: "switch"; target: string }
  | { kind: "status" };

export type PermCommand =
  | { kind: "status" }
  | { kind: "list" }
  | { kind: "switch"; target: string }
  | { kind: "default"; target?: string };

export type ReasoningCommand =
  | { kind: "status" }
  | { kind: "list" }
  | { kind: "switch"; target: string }
  | { kind: "clear" };

/** Busy-time delivery behavior switch (`/enter`), shared with the DSH setting. */
export type EnterCommand =
  | { kind: "status" }
  | { kind: "switch"; target: "queue" | "steer" };

/**
 * Parse `/workspace` (alias `/ws`):
 *   list | status | switch <path|n> | add <path>
 */
export function parseWorkspaceCommand(text: string): WorkspaceCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:workspace|ws)\s+(list|status|switch|add)(?:\s+(.*))?$/);
  if (!m) return null;
  const sub = m[1] as "list" | "status" | "switch" | "add";
  const rest = (m[2] ?? "").trim();
  switch (sub) {
    case "list":
    case "status":
      return { kind: sub };
    case "switch":
      if (!rest) return null;
      return { kind: "switch", target: rest };
    case "add":
      if (!rest) return null;
      return { kind: "add", path: rest };
  }
}

/**
 * Parse `/session` (alias `/s`):
 *   list [current] | switch <n> | new | status
 */
export function parseSessionCommand(text: string): SessionCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:session|s)\s+(list|switch|new|status)(?:\s+(.*))?$/);
  if (!m) return null;
  const sub = m[1] as "list" | "switch" | "new" | "status";
  const rest = (m[2] ?? "").trim();
  switch (sub) {
    case "list": {
      if (!rest) return { kind: "list" };
      if (rest === "current") return { kind: "list", scope: "current" };
      return null;
    }
    case "new":
    case "status":
      return { kind: sub };
    case "switch": {
      if (!/^\d+$/.test(rest)) return null;
      return { kind: "switch", index: parseInt(rest, 10) };
    }
  }
}

/**
 * Parse `/preset` (alias `/p`; legacy aliases `/agent`, `/a` still parse):
 *   list | switch <name|n> | status
 *
 * The preset default lives in the DSH settings document (`agent-presets`
 * namespace), the same one the GUI settings page edits — `/preset switch`
 * writes that document, so GUI and WeChat stay in sync.
 */
export function parsePresetCommand(text: string): PresetCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:preset|p|agent|a)\s+(list|switch|status)(?:\s+(.*))?$/);
  if (!m) return null;
  const sub = m[1] as "list" | "switch" | "status";
  const rest = (m[2] ?? "").trim();
  switch (sub) {
    case "list":
    case "status":
      return { kind: sub };
    case "switch":
      if (!rest) return null;
      return { kind: "switch", target: rest };
  }
}

/**
 * Parse `/model`:
 *   list [provider] | switch <provider/model> | status
 */
export function parseModelCommand(text: string): ModelCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:model)\s+(list|switch|status)(?:\s+(.*))?$/);
  if (!m) return null;
  const sub = m[1] as "list" | "switch" | "status";
  const rest = (m[2] ?? "").trim();
  switch (sub) {
    case "status":
      return { kind: "status" };
    case "list":
      return { kind: "list", ...(rest ? { provider: rest } : {}) };
    case "switch":
      if (!rest || !rest.includes("/")) return null;
      return { kind: "switch", target: rest };
  }
}

/**
 * Parse `/perm` (alias `/permission`):
 *   status | list | switch <名称|编号> | default [名称|编号]
 *
 * Session-level switches (`switch`) go through the native permissionPresets
 * service and take effect on the current session immediately; `default`
 * writes the DSH settings document (`permission` namespace) — the same
 * default the GUI settings page's Permission row edits, so both sides stay
 * in sync and new sessions pick it up natively.
 */
export function parsePermCommand(text: string): PermCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:perm|permission)\s+(list|status|switch|default)(?:\s+(.*))?$/);
  if (!m) return null;
  const sub = m[1] as "list" | "status" | "switch" | "default";
  const rest = (m[2] ?? "").trim();
  switch (sub) {
    case "list":
    case "status":
      return { kind: sub };
    case "switch":
      if (!rest) return null;
      return { kind: "switch", target: rest };
    case "default":
      return { kind: "default", ...(rest ? { target: rest } : {}) };
  }
}

/**
 * Parse `/reasoning`:
 *   (bare) | list | default | switch <等级>
 *
 * The reasoning effort rides the same selection as the model: `/reasoning`
 * with no argument reports the current/default effort and the current
 * model's supported levels; `default` clears it (provider/model default);
 * `switch <等级>` switches the effort (by id or display name), applying to
 * the current session immediately and persisting as the new default.
 * The explicit `switch` keyword matches the other management commands
 * (`/workspace`, `/session`, `/preset`, `/model`, `/perm`).
 */
export function parseReasoningCommand(text: string): ReasoningCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/reasoning(?:\s+(list|default|switch)(?:\s+(.*))?)?$/);
  if (!m) return null;
  const sub = m[1] as "list" | "default" | "switch" | undefined;
  if (!sub) return { kind: "status" };
  const rest = (m[2] ?? "").trim();
  switch (sub) {
    case "list":
      return { kind: "list" };
    case "default":
      return { kind: "clear" };
    case "switch":
      if (!rest) return null;
      return { kind: "switch", target: rest };
  }
}

/**
 * Parse `/enter` (alias `/busy`) — busy-time delivery behavior, shared with
 * the DSH General Settings 「繁忙时 Enter 键行为」 preference
 * (`ui-conversation.busyEnter`):
 *   /enter              → status
 *   /enter status       → status
 *   /enter queue|q|排队 → switch to queue (running messages wait for a new turn)
 *   /enter steer|s|插话 → switch to steer (splice into the running turn)
 *
 * Returns null for unknown subcommands so the text falls through to the
 * unknown-command hint + agent forwarding.
 */
export function parseEnterCommand(text: string): EnterCommand | null {
  const trimmed = text.trim().toLowerCase();
  const m = trimmed.match(/^\/(?:enter|busy)(?:\s+(.*))?$/);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (!rest || rest === "status") return { kind: "status" };
  if (rest === "queue" || rest === "q" || rest === "排队") {
    return { kind: "switch", target: "queue" };
  }
  if (rest === "steer" || rest === "s" || rest === "插话") {
    return { kind: "switch", target: "steer" };
  }
  return null;
}

// ─── History ────────────────────────────────────────────────────────────────

export const HISTORY_DEFAULT = 5;
export const HISTORY_MAX = 20;

export type HistoryCommand = { kind: "history"; count: number };

/**
 * Parse `/history [N]` — view recent conversation history.
 *   /history        → 5 (default)
 *   /history 10     → 10
 *   /history 30     → 20 (clamped to HISTORY_MAX)
 *
 * Returns null for: invalid number (non-integer, <=0, NaN), extra
 * trailing garbage that is not a number, or non-history prefix.
 * The caller detects a leading `/history` with an invalid arg and
 * replies with usage instead of forwarding to the agent.
 */
export function parseHistoryCommand(text: string): HistoryCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/history(?:\s+(.*))?$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (!rest) return { kind: "history", count: HISTORY_DEFAULT };
  // Only a single integer token is allowed; anything else is invalid.
  if (!/^\d+$/.test(rest)) return null;
  const n = parseInt(rest, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { kind: "history", count: Math.min(n, HISTORY_MAX) };
}

/**
 * True if text looks like a /history attempt (including invalid args),
 * used to decide whether to show usage instead of forwarding to agent.
 */
export function isHistoryCommandAttempt(text: string): boolean {
  return /^\s*\/history\b/i.test(text);
}

/**
 * True if `text` is a recognized slash command that should BYPASS any
 * pending question/approval card and execute normally.
 *
 * The bridge pre-empts the next user text after a `question/requested` or
 * `approval/requested` frame, treating it as the card's answer. Without
 * this helper, typing a management command (e.g. `/next`) while a card
 * is shown silently submits the command text as the card's custom-text
 * answer (questions) or rejects it as "unrecognized reply" (approvals),
 * dropping the user's real intent.
 *
 * Card-specific commands (`/rp`, `/rq`) are intentionally excluded so
 * they keep their existing card semantics. `/stop` is also excluded: it
 * lives in `handleQuestionReply`'s priority branch (stop-agent +
 * reject-question) and a behaviour change is out of scope. `/help` is
 * included: its only effect is "print the help text", which
 * `handleMessage` already handles; the card handlers' two duplicate
 * `parseHelpCommand` branches become dead code once `/help` bypasses.
 *
 * Empty text returns false (the empty-text card hint still fires).
 */
export function isBypassSlashCommand(text: string): boolean {
  if (!text) return false;
  return (
    parseHelpCommand(text) ||
    parseNextCommand(text) ||
    parseSilentCommand(text) !== null ||
    parseStatusCommand(text) !== null ||
    parseWorkspaceCommand(text) !== null ||
    parseSessionCommand(text) !== null ||
    parsePresetCommand(text) !== null ||
    parseModelCommand(text) !== null ||
    parsePermCommand(text) !== null ||
    parseReasoningCommand(text) !== null ||
    parseEnterCommand(text) !== null ||
    parseNotifyCommand(text) !== null ||
    parseHistoryCommand(text) !== null
  );
}

/**
 * DSH `ctx.commands` names already documented by the local whitelist
 * below. Used by `formatHelp(nativeCommands)` to de-duplicate the
 * "/xxx — 说明" section so users do not see two rows for the same
 * name (the local row stays the authoritative one because it carries
 * the full subcommand grammar; native rows only describe their
 * discovery-surface description).
 */
export const LOCAL_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "help",
  "status",
  "workspace",
  "ws",
  "session",
  "s",
  "preset",
  "p",
  "agent",
  "a",
  "model",
  "perm",
  "permission",
  "reasoning",
  "enter",
  "busy",
  "silent",
  "sl",
  "stop",
  "next",
  "history",
  "rp",
  "reject-permission",
  "rq",
  "reject-question",
  "notify",
  "watch",
  "notice",
]);

/** The /help reply, optionally augmented with native command descriptors. */
export function formatHelp(
  nativeCommands?: ReadonlyArray<{ name: string; description?: string; input?: { hint?: string } }>,
): string {
  const lines: string[] = [
    "🤖 DSH 微信助手 — 命令列表",
    "",
    "• /help (h, ?) — 显示帮助",
    "• /status — 当前会话、工作区、Agent、待处理卡、默认/当前会话 Preset、模型状态",
    "• /workspace (ws) — list | status | switch <路径|编号> | add <路径>",
    "• /session (s) — list [current] | switch <编号> | new | status",
    "• /preset (p) — list | switch <名称|编号> | status（默认 preset，与 GUI 同步；status 看全局默认，不是当前会话）",
    "• /model — list [提供商] | switch <提供商/模型> | status",
    "• /perm (permission) — status | list | switch <名称|编号> | default [名称|编号]（会话权限实时切换；默认写入 DSH 设置，与 GUI 同步）",
    "• /reasoning — 查看/设置推理等级：/reasoning [list|default|switch <等级>]",
    "• /enter (busy) — queue|steer|status 繁忙时消息投递（排队/插话，与 DSH 设置「繁忙时 Enter 键行为」同步）",
    "• /silent on|off (sl) — 静默模式：只发送每轮最终回复",
    "• /notify on|off|status (watch) — 跨会话通知：完成/报错/卡片（默认关闭）",
    "• /history [数量] — 查看最近历史消息（默认 5 条，最多 20 条）；有待处理卡时会完整重发",
    "• /stop — 中断当前任务",
    "• /next — 继续发送因微信限制被缓存的消息",
    "• /rp — 拒绝所有待处理权限卡（微信端）",
    "• /rq — 拒绝所有待处理的问题卡（微信端）",
  ];
  if (nativeCommands && nativeCommands.length > 0) {
    lines.push("", "── DSH 原生命令（当前 profile 已注册）──");
    for (const cmd of nativeCommands) {
      if (LOCAL_COMMAND_NAMES.has(cmd.name)) continue;
      const desc = cmd.description?.trim() || "(未提供说明)";
      const hint = cmd.input?.hint ? `  ${cmd.input.hint}` : "";
      lines.push(`• /${cmd.name}${hint} — ${desc}`);
    }
  }
  lines.push(
    "",
    "权限审批完全走 DSH 原生机制（沙箱升级触发），GUI 与微信双端同卡，谁先回复谁生效。",
    "其他 /xxx 命令会作为文本转发给 agent。",
  );
  return lines.join("\n");
}

/**
 * Render one projection value into a WeChat-bounded one-liner.
 *
 * The `ctx.sessionProjections.snapshot(session).values` map is
 * `Record<string, unknown>` — the bridge does not (and intentionally
 * cannot) know each plugin's exact shape. Generic rule:
 *
 * - `null` / `undefined` → literal text `null` / `undefined` so users
 *   can see at a glance whether a key has state (vs. being absent).
 * - `string` / `number` / `boolean` / `bigint` → `String(v)`.
 * - `function` / `symbol` → `undefined` (skip — never legitimate value).
 * - everything else (objects, arrays) → `JSON.stringify(v)` in compact
 *   form. If the result is longer than 120 code units, truncate to 117
 *   and append `…` — WeChat per-message cap is 4 KB but a single
 *   projection line should stay readable on phone screens.
 * - circular references / BigInt / values JSON cannot serialize →
 *   `undefined`; the caller skips the key and logs once. We never
 *   surface an unsanitized shape back to the user.
 *
 * Pure function — no I/O, no side effects, fully testable.
 *
 * @param v The projection's view output (schema-validated host side).
 * @returns A WeChat-ready one-liner, or `undefined` to drop the row.
 */
export function renderProjectionValue(v: unknown): string | undefined {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
    return truncateForWeChat(String(v));
  }
  if (t === "function" || t === "symbol") return undefined;
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    // circular refs, BigInt inside an object, etc.
    return undefined;
  }
  // JSON.stringify never returns undefined for object/array inputs.
  if (s === undefined) return undefined;
  return truncateForWeChat(s);
}

/** Cap a string at the given limit, append `…` if over. */
function truncateForWeChat(s: string, limit = 120): string {
  if (s.length <= limit) return s;
  let end = limit - 3;
  // Do not split a UTF-16 surrogate pair — iLink rejects lone surrogates
  // with `ret=-1 invalid request` and the poisoned payload then blocks flush.
  if (end > 0) {
    const prev = s.charCodeAt(end - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) end -= 1;
  }
  return s.slice(0, Math.max(0, end)) + "…";
}

// ─── Smart projection renderers ──────────────────────────────────────────
//
// Each renderer turns one host-side projection's `view` shape into a
// WeChat-friendly, human-readable string (or returns `undefined` to
// signal "shape unrecognised — fall back to generic JSON"). Each one
// is a pure pure-function and fully testable in isolation.
//
// Renderer design rule: be tolerant of partial / renamed fields by
// probing alternative field names (`uncachedInputTokens` vs
// `inputTokens`, `pressureTokens` vs `projectedTokens`, etc.). When a
// projection author changes something, the worst that happens is the
// renderer returns `undefined` → the caller falls back to a JSON
// line — visible to the user, never silent.
//
// ---------------------------------------------------------------------------

/**
 * Compact, locale-stable token count.
 * - `< 1 000` → `"123"`
 * - `< 1 000 000` → `"12.3k"` (one decimal)
 * - `>= 1 000 000` → `"1.5M"` (one decimal)
 */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Compact byte count (`"5.2 MB"`, `"1.2 GB"`). */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Compact duration in ms (`"1.5s"`, `"16m"`, `"2h"`). */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return String(ms);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Relative-time label in Chinese, matching the GUI sidebar's compact style. */
function formatRelativeTime(epoch: number): string {
  const diff = Date.now() - epoch;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

type ProjectionGroup = "mode" | "usage" | "session" | "other";

/** Known-DSH-keys → category bucket. Unknown keys fall through to `"other"`. */
const PROJECTION_GROUP: Record<string, ProjectionGroup> = {
  // Modes — collaboration state the user toggles or the agent flips
  plan: "mode",
  goal: "mode",
  subagent: "mode",
  todos: "mode",
  // Usage / stats — numeric snapshots the user tracks
  contextPressure: "usage",
  contextBreakdown: "usage",
  tokenUsage: "usage",
  sessionStats: "usage",
  subagentTiming: "usage",
  // Session — label / settings the user owns
  title: "session",
  sessionListMetadata: "session",
  permissions: "session",
  imageLimits: "session",
};

const GROUP_ORDER: ProjectionGroup[] = ["mode", "usage", "session", "other"];
const GROUP_LABELS: Record<ProjectionGroup, string> = {
  mode: "模式",
  usage: "用量与统计",
  session: "会话",
  other: "其它",
};

/** Strict shape guards: keep the smart renderers' field probes safe under `noUncheckedIndexedAccess`. */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

// ─── Per-key smart renderers ────────────────────────────────────────────

function renderPlanProjection(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const active = bool(v.active);
  if (active === undefined) return undefined;
  const pending = v.pending;
  if (pending === true) return active ? "on（下一次轮次关闭）" : "off（下一次轮次开启）";
  return active ? "on" : "off";
}

function renderGoalProjection(v: unknown): string | undefined {
  if (v === null) return "（无）";
  if (!isObj(v)) return undefined;
  const goal = isObj(v.goal) ? v.goal : undefined;
  if (!goal) return undefined;
  const phase = str(goal.phase);
  if (!phase) return undefined;
  const rounds = `${num(v.roundsStarted) ?? 0}/${num(goal.maxGoalRounds) ?? "?"}`;
  const obj = str(goal.objective);
  const objSuffix = obj ? truncateForWeChat(obj, 40) : "（无目标）";
  if (phase === "blocked") {
    const reason = isObj(goal.blockedReason) ? goal.blockedReason : undefined;
    const code = reason ? str(reason.code) : undefined;
    if (code) return `${phase} · ${rounds} 轮 · 阻塞 (${code})`;
  }
  return `${phase} · ${objSuffix} · ${rounds} 轮`;
}

function renderSubagentProjection(v: unknown): string | undefined {
  if (v === null) return "（无）";
  if (!isObj(v)) return undefined;
  const status = str(v.status) ?? "active";
  const count = Array.isArray(v.children) ? v.children.length : num(v.count);
  return count !== undefined ? `${status} · ${count} 个子任务` : `${status}`;
}

function renderTodosProjection(v: unknown): string | undefined {
  if (v === null) return "（无）";
  if (!isObj(v)) return undefined;
  const items = Array.isArray(v.items) ? v.items : undefined;
  if (!items) return undefined;
  const total = items.length;
  const pending = items.filter((t) => {
    if (!isObj(t)) return true;
    const s = str(t.status);
    return s !== "done" && s !== "completed" && s !== "cancelled";
  }).length;
  return `${total} 个 · ${pending} 待办`;
}

function renderContextPressureProjection(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const window = num(v.contextWindow);
  if (window === undefined || window <= 0) return undefined;
  const projected = num(v.projectedTokens) ?? num(v.pressureTokens);
  if (projected === undefined) return undefined;
  const pct = Math.round((projected / window) * 100);
  return `${formatTokens(projected)} / ${formatTokens(window)}（${pct}%）`;
}

function renderContextBreakdownProjection(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const parts: string[] = [];
  const sys = num(v.systemTokens);
  const tools = num(v.toolsTokens) ?? num(v.toolsEstimateTokens);
  const msg = num(v.messageTokens);
  if (sys !== undefined) parts.push(`系统 ${formatTokens(sys)}`);
  if (tools !== undefined) parts.push(`工具 ${formatTokens(tools)}`);
  if (msg !== undefined) parts.push(`消息 ${formatTokens(msg)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function renderTokenUsageProjection(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const inUncached = num(v.uncachedInputTokens) ?? num(v.inputTokens);
  const inCached = num(v.cacheReadTokens);
  const out = num(v.outputTokens);
  const write = num(v.cacheWriteTokens);
  if (inUncached === undefined && out === undefined && write === undefined) return undefined;
  const lines: string[] = [];
  if (inUncached !== undefined) {
    let s = `输入 ${formatTokens(inUncached)}`;
    if (inCached !== undefined && inCached > 0) {
      const total = inUncached + inCached;
      s += ` (缓存命中 ${formatTokens(inCached)}`;
      if (total > 0) s += `, 命中率 ${Math.round((inCached / total) * 100)}%`;
      s += ")";
    }
    lines.push(s);
  }
  if (out !== undefined) lines.push(`输出 ${formatTokens(out)}`);
  if (write !== undefined && write > 0) lines.push(`缓存写入 ${formatTokens(write)}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function renderSessionStatsProjection(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const turns = num(v.turns);
  const steps = num(v.steps);
  const llmMs = num(v.llmMs);
  const toolMs = num(v.toolMs);
  const ttftMs = num(v.ttftMs);
  const ttftSteps = num(v.ttftSteps);
  const lines: string[] = [];
  if (turns !== undefined && steps !== undefined) lines.push(`${turns} turns · ${steps} steps`);
  const timing: string[] = [];
  if (llmMs !== undefined) timing.push(`llm ${formatMs(llmMs)}`);
  if (toolMs !== undefined) timing.push(`tool ${formatMs(toolMs)}`);
  if (ttftMs !== undefined) {
    let s = `ttft ${formatMs(ttftMs)}`;
    if (ttftSteps !== undefined) s += ` / ${ttftSteps} steps`;
    timing.push(s);
  }
  if (timing.length > 0) lines.push(timing.join(" · "));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function renderSubagentTimingProjection(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const ms = num(v.settledMs);
  if (ms === undefined) return undefined;
  return ms === 0 ? "未结算" : formatMs(ms);
}

function renderTitleProjection(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.length === 0 ? "（未设标题）" : v;
}

function renderSessionListMetadataProjection(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const parts: string[] = [];
  const last = num(v.lastPromptAt);
  if (last !== undefined && last > 0) parts.push(`上次活动 ${formatRelativeTime(last)}`);
  const blank = bool(v.blank);
  if (blank !== undefined) parts.push(blank ? "空白会话" : "非空");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function renderPermissionsProjection(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const opts = Array.isArray(v.options) ? v.options : undefined;
  if (!opts) return undefined;
  const labels = opts
    .map((o) => (isObj(o) ? (str(o.name) ?? str(o.value) ?? str(o.label)) : undefined))
    .filter((s): s is string => s !== undefined);
  return labels.length > 0 ? labels.join(" · ") : undefined;
}

function renderImageLimitsProjection(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  const parts: string[] = [];
  const bytes = num(v.maxImageBytes);
  if (bytes !== undefined) parts.push(`${formatBytes(bytes)} / 张`);
  const perMsg = num(v.maxImagesPerMessage);
  if (perMsg !== undefined) parts.push(`${perMsg} 张 / 消息`);
  const pixels = num(v.maxImagePixels);
  if (pixels !== undefined) parts.push(`≤ ${Math.round(pixels / 1_000_000)}M px`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Map of known DSH projection keys → smart renderer.
 * Each renderer returns a WeChat-ready string (possibly multi-line) or
 * `undefined` when the value's shape is unrecognised. Renderers are
 * pure, isolated, fully tested.
 */
const PROJECTION_RENDERERS: Record<string, (v: unknown) => string | undefined> = {
  plan: renderPlanProjection,
  goal: renderGoalProjection,
  subagent: renderSubagentProjection,
  todos: renderTodosProjection,
  contextPressure: renderContextPressureProjection,
  contextBreakdown: renderContextBreakdownProjection,
  tokenUsage: renderTokenUsageProjection,
  sessionStats: renderSessionStatsProjection,
  subagentTiming: renderSubagentTimingProjection,
  title: renderTitleProjection,
  sessionListMetadata: renderSessionListMetadataProjection,
  permissions: renderPermissionsProjection,
  imageLimits: renderImageLimitsProjection,
};

/**
 * Render the full projection section that `/status` appends under the
 * "── 会话级状态 ──" banner.
 *
 * Algorithm:
 *   1. For each key (alphabetically sorted within its group), pick a
 *      smart renderer when known or fall back to `renderProjectionValue`.
 *   2. Group keys into `[模式]`, `[用量与统计]`, `[会话]`, `[其它]`
 *      buckets; emit each non-empty bucket as `[label]` + indented
 *      `• key:` lines (with multi-line continuation indented deeper).
 *   3. Empty buckets are dropped. The caller decides whether the
 *      whole section appears.
 *
 * Smart renderer exceptions are caught and downgraded to the JSON
 * fallback for that single key; other keys still render. The caller
 * does not see exceptions and `/status` stays intact.
 *
 * @param values The `snapshot(session).values` map from
 *   `ctx.sessionProjections`.
 * @returns Pre-formatted lines ready to be appended to `/status`.
 *   Empty when `values` has no keys with renderable output.
 */
export function renderProjectionSection(values: Record<string, unknown>): string[] {
  type Bucket = Array<{ key: string; lines: string[] }>;
  const buckets: Record<ProjectionGroup, Bucket> = {
    mode: [],
    usage: [],
    session: [],
    other: [],
  };

  for (const key of Object.keys(values).sort()) {
    const group = PROJECTION_GROUP[key] ?? "other";
    const value = values[key];

    let rendered: string | string[] | undefined;
    try {
      const fn = PROJECTION_RENDERERS[key];
      const out = fn ? fn(value) : renderProjectionValue(value);
      rendered = out === undefined ? renderProjectionValue(value) : out;
    } catch (err) {
      console.warn(`[dsh-wechat] projection ${key} renderer failed: ${String(err)}`);
      rendered = renderProjectionValue(value);
    }

    if (rendered === undefined) continue;
    const lines = Array.isArray(rendered) ? rendered : rendered.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    buckets[group].push({ key, lines });
  }

  const out: string[] = [];
  for (const g of GROUP_ORDER) {
    const items = buckets[g];
    if (items.length === 0) continue;
    out.push(`[${GROUP_LABELS[g]}]`);
    for (const { key, lines } of items) {
      out.push(`  • ${key}: ${lines[0]!}`);
      for (let i = 1; i < lines.length; i++) {
        out.push(`      ${lines[i]!}`);
      }
    }
    out.push("");
  }
  // Trim trailing blank line so the section joins cleanly with whatever
  // the caller appends next (currently nothing — the `/status` output
  // ends here).
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}
