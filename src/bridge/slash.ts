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
  | { kind: "list" }
  | { kind: "switch"; index: number }
  | { kind: "new" }
  | { kind: "status" };

export type AgentCommand =
  | { kind: "list" }
  | { kind: "switch"; target: string }
  | { kind: "status" };

export type ModelCommand =
  | { kind: "list"; provider?: string }
  | { kind: "switch"; target: string }
  | { kind: "status" };

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
 *   list | switch <n> | new | status
 */
export function parseSessionCommand(text: string): SessionCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:session|s)\s+(list|switch|new|status)(?:\s+(.*))?$/);
  if (!m) return null;
  const sub = m[1] as "list" | "switch" | "new" | "status";
  const rest = (m[2] ?? "").trim();
  switch (sub) {
    case "list":
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
 * Parse `/agent` (alias `/a`):
 *   list | switch <name|n> | status
 */
export function parseAgentCommand(text: string): AgentCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:agent|a)\s+(list|switch|status)(?:\s+(.*))?$/);
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

/** The /help reply. */
export function formatHelp(): string {
  return [
    "🤖 DSH 微信助手 — 命令列表",
    "",
    "• /help (h, ?) — 显示帮助",
    "• /status — 当前会话、工作区、Agent、模型状态",
    "• /workspace (ws) — list | status | switch <路径|编号> | add <路径>",
    "• /session (s) — list | switch <编号> | new | status",
    "• /agent (a) — list | switch <名称|编号> | status",
    "• /model — list [提供商] | switch <提供商/模型> | status",
    "• /silent on|off (sl) — 静默模式：只发送每轮最终回复",
    "• /stop — 中断当前任务",
    "• /rp — 拒绝所有待处理权限卡（微信端）",
    "• /rq — 拒绝所有待处理的问题卡（微信端）",
    "",
    "权限审批完全走 DSH 原生机制（沙箱升级触发），GUI 与微信双端同卡，谁先回复谁生效。",
    "其他 /xxx 命令会作为文本转发给 agent。",
  ].join("\n");
}
