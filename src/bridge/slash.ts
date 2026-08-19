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

export type CompactCommand = { kind: "compact"; extra: string };

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
 *   (bare) | list | default | <等级>
 *
 * The reasoning effort rides the same selection as the model: `/reasoning`
 * with no argument reports the current/default effort and the current
 * model's supported levels; `default` clears it (provider/model default);
 * anything else switches the effort (by id or display name), applying to
 * the current session immediately and persisting as the new default.
 */
export function parseReasoningCommand(text: string): ReasoningCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/reasoning(?:\s+(.*))?$/);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (!rest) return { kind: "status" };
  if (rest === "list") return { kind: "list" };
  if (rest === "default") return { kind: "clear" };
  return { kind: "switch", target: rest };
}

/**
 * Parse `/compact`:
 *   (bare) | (args)
 *
 * The compaction service rejects any extra input with a usage error; we
 * capture the trailing input verbatim so the handler can echo the same
 * usage message the registered `dsh-command-compact` handler renders for
 * the GUI. Bare `/compact` and trailing-whitespace-only inputs are the
 * two valid forms.
 */
export function parseCompactCommand(text: string): CompactCommand | null {
  const m = text.trim().match(/^\/compact(?:\s+(.*))?$/);
  if (!m) return null;
  return { kind: "compact", extra: (m[1] ?? "").trim() };
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
    parseCompactCommand(text) !== null
  );
}

/** The /help reply. */
export function formatHelp(): string {
  return [
    "🤖 DSH 微信助手 — 命令列表",
    "",
    "• /help (h, ?) — 显示帮助",
    "• /status — 当前会话、工作区、Agent、模型状态",
    "• /workspace (ws) — list | status | switch <路径|编号> | add <路径>",
    "• /session (s) — list [current] | switch <编号> | new | status",
    "• /preset (p) — list | switch <名称|编号> | status（改的是 DSH 设置的默认 preset，与 GUI 同步）",
    "• /model — list [提供商] | switch <提供商/模型> | status",
    "• /perm (permission) — status | list | switch <名称|编号> | default [名称|编号]（会话权限实时切换；默认写入 DSH 设置，与 GUI 同步）",
    "• /reasoning — 查看/设置推理等级：/reasoning [list|default|<等级>]",
    "• /compact — 手动触发当前会话历史压缩（与 GUI /compact 等价）",
    "• /silent on|off (sl) — 静默模式：只发送每轮最终回复",
    "• /stop — 中断当前任务",
    "• /next — 继续发送因微信限制被缓存的消息",
    "• /rp — 拒绝所有待处理权限卡（微信端）",
    "• /rq — 拒绝所有待处理的问题卡（微信端）",
    "",
    "权限审批完全走 DSH 原生机制（沙箱升级触发），GUI 与微信双端同卡，谁先回复谁生效。",
    "其他 /xxx 命令会作为文本转发给 agent。",
  ].join("\n");
}
