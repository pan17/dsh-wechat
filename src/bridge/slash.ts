/**
 * WeChat slash-command parsers.
 *
 * Ported and trimmed from wechat-opencode (MIT) —
 * https://github.com/pan17/wechat-opencode (src/adapter/workspace-cmd.ts).
 * Only the commands the DSH bridge handles itself are kept: DSH owns
 * workspace/session/agent/model management in its GUI, so those commands
 * are intentionally absent here.
 *
 * This module also owns the two `/help` renderers (`formatHelp` and
 * `helpTopicBlock`). Their wording is NOT written here — it comes from
 * `src/help-catalog.ts`, the same catalog the settings page renders, so the
 * WeChat reply and the GUI panel can never disagree.
 */

import { findHelpEntry, helpCatalog, shortestSpelling } from "../help-catalog.js";

export type HelpCommand = { kind: "help" };
export type StatusCommand = { kind: "status" };
export type SilentCommand = { kind: "silent"; mode: "on" | "off" | "status" };
export type FinalCommand = { kind: "final"; mode: "on" | "off" | "status" };
export type MergeCommand = { kind: "merge"; mode: "on" | "off" | "status" };
/**
 * `/media` — 图片/文件与文字合并发送 + 附件交付措辞.
 *
 * One command, two independent switches (whether to hold a caption-less
 * attachment for the sentence typed next, and how the saved file is spelled in
 * the prompt), because a user asks for them together ("send the picture AND the
 * question") and splitting them across two commands would make neither
 * discoverable.
 *
 * `at|path` changes the SPELLING only: `adapter/inbound.ts` hands over a pointer
 * in both cases and never inlines the file's content.
 */
export type MediaCommand =
  | { kind: "media"; target: "merge"; mode: "on" | "off" }
  | { kind: "media"; target: "ref"; style: "at" | "path" }
  | { kind: "media"; target: "status" };
export type SurfaceCommand = { kind: "surface"; mode: "on" | "off" | "status" };
export type StopCommand = { kind: "stop" };
export type RejectQuestionCommand = { kind: "reject-question" };
export type RejectPermissionCommand = { kind: "reject-permission" };
export type NotifyCommand =
  | { kind: "status" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "tasks-on" }
  | { kind: "tasks-off" };

export type SlashCommand =
  | HelpCommand
  | StatusCommand
  | SilentCommand
  | FinalCommand
  | MergeCommand
  | MediaCommand
  | StopCommand
  | RejectQuestionCommand
  | RejectPermissionCommand;

/**
 * Parse `/help` (aliases `/h`, `/?`), optionally with a command name.
 *
 *   /help                 → `true`   (the listing)
 *   /help s               → `{ topic: "s" }`  (that command's examples)
 *   /help session         → `{ topic: "session" }`
 *   /help fuck            → `{ unknown: "fuck" }` (listing + "没有这条命令")
 *   /help me write a test → `{ unknown: "me write a test" }` (same)
 *
 * Everything after `/help` is a COMMAND NAME, so a line that does not resolve
 * to a documented command is still a help request: it gets "没有 /xxx 这条命令"
 * plus the listing, never a forwarded sentence. Forwarding it would answer a
 * help request with "未知命令 /help", which is the one reply guaranteed to be
 * wrong — the user is asking for help. This matches `man`, which answers an
 * unknown page with an error and its own usage instead of ignoring the word.
 *
 * The only non-help shape left is `/help` followed by NOTHING but whitespace,
 * which is the plain listing.
 */
export function parseHelpCommand(
  text: string,
): boolean | { topic: string } | { unknown: string } {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:help|h|\?)(?:\s+(.*))?$/i);
  if (!m) return false;
  const rest = (m[1] ?? "").trim();
  if (!rest) return true;
  return findHelpEntry(rest) ? { topic: rest } : { unknown: rest };
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

/**
 * Parse `/final` (alias `/fo`) — query or toggle 结论模式 (final-only).
 * Bare command defaults to status.
 *
 * `/f` is deliberately NOT an alias: it already means `/flush`, and
 * "take back what is held" is the opposite of "start holding". `/fo`
 * is the shortest unambiguous prefix.
 */
export function parseFinalCommand(text: string): FinalCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/final" || trimmed === "/fo") {
    return { kind: "final", mode: "status" };
  }
  const m = trimmed.match(/^\/(?:final|fo)\s+(on|off|status)\s*$/);
  if (!m) return null;
  return { kind: "final", mode: m[1] as "on" | "off" | "status" };
}

/**
 * Parse `/merge` (alias `/mg`) — query or toggle the inbound merge window
 * (打字合并). Bare command defaults to status.
 *
 * The alias must not collide with an existing name: `/m` is NOT used (it
 * would be the shortest but is not obviously "merge"), and `/mg` is free —
 * `tests/merge-window.test.ts` asserts the whole alias table for collisions.
 */
export function parseMergeCommand(text: string): MergeCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/merge" || trimmed === "/mg") {
    return { kind: "merge", mode: "status" };
  }
  const m = trimmed.match(/^\/(?:merge|mg)\s+(on|off|status)\s*$/);
  if (!m) return null;
  return { kind: "merge", mode: m[1] as "on" | "off" | "status" };
}

/**
 * Parse `/media` (alias `/md`) — 图片/文件与文字合并发送, plus how a saved
 * attachment is spelled in the prompt:
 *
 *   /media                    → status (both switches + the current wording)
 *   /media on|off             → hold a caption-less image/file/video and send
 *                               it together with the text typed next
 *   /media at|path            → `@路径` reference (default) vs. the plain-path
 *                               "文件已保存到: 路径" wording — SPELLING only,
 *                               neither inlines the file's content
 *
 * `/md` is safe: `/m`, `/mo` and `/me` are already taken or ambiguous, while
 * `/md` collides with nothing in `LOCAL_COMMAND_NAMES` (asserted by the alias
 * guard in tests/media-merge.test.ts).
 */
export function parseMediaCommand(text: string): MediaCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/media" || trimmed === "/md") return { kind: "media", target: "status" };
  const m = trimmed.match(/^\/(?:media|md)\s+(on|off|status|at|path)\s*$/);
  if (!m) return null;
  const sub = m[1]!;
  if (sub === "on" || sub === "off") return { kind: "media", target: "merge", mode: sub };
  if (sub === "at" || sub === "path") return { kind: "media", target: "ref", style: sub };
  return { kind: "media", target: "status" };
}

/**
 * Parse `/surface` (alias `/wxprompt`) — query or toggle the WeChat
 * surface-prompt injection. Bare command defaults to status. The prompt
 * text itself is edited from the settings page, not this command.
 */
export function parseSurfaceCommand(text: string): SurfaceCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/surface" || trimmed === "/wxprompt") {
    return { kind: "surface", mode: "status" };
  }
  const m = trimmed.match(/^\/(?:surface|wxprompt)\s+(on|off|status)\s*$/);
  if (!m) return null;
  return { kind: "surface", mode: m[1] as "on" | "off" | "status" };
}

/** Parse `/stop`. */
export function parseStopCommand(text: string): StopCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/stop") return { kind: "stop" };
  return null;
}

/**
 * Parse `/notify` (aliases `/watch`, `/notice`) — cross-session decision
 * push, plus an independent task-event toggle:
 *   /notify                → status
 *   /notify status         → status
 *   /notify on|off         → decision-card gate
 *   /notify tasks on|off   → background turn/end + error notices
 */
export function parseNotifyCommand(text: string): NotifyCommand | null {
  const trimmed = text.trim().toLowerCase();
  const m = trimmed.match(/^\/(?:notify|watch|notice)(?:\s+(.*))?$/);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (!rest || rest === "status") return { kind: "status" };
  if (rest === "on" || rest === "enable" || rest === "enabled") return { kind: "on" };
  if (rest === "off" || rest === "disable" || rest === "disabled") return { kind: "off" };
  const tasks = rest.match(/^tasks?\s+(on|off|enable|enabled|disable|disabled)$/);
  if (tasks) {
    const value = tasks[1]!;
    if (value === "on" || value === "enable" || value === "enabled") return { kind: "tasks-on" };
    return { kind: "tasks-off" };
  }
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

/**
 * Parse `/flush` (alias `/f`) — deliver whatever 结论模式 (final-only) is
 * currently holding, without waiting for the quiescence timer. This is the
 * escape hatch for "I can see it is done, tell me now".
 */
export function parseFlushCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed === "/flush" || trimmed === "/f";
}

/** Parse `/reject-question` (alias `/rq`). */
export function parseRejectQuestionCommand(text: string): RejectQuestionCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/reject-question" || trimmed === "/rq") {
    return { kind: "reject-question" };
  }
  return null;
}

/**
 * Parse a `P{n}=…` / `P{n}:…` / `P{n}-…` prefix that addresses one pending
 * card by its WeChat number. Used so a lone cross-session card cannot
 * swallow a bare reply meant for the current session, and so `P1=/rq`
 * closes that card instead of being forwarded as chat.
 */
export function parsePnCardReply(text: string): { index: number; rest: string } | null {
  return parseAllPnCardReplies(text)[0] ?? null;
}

/** Every `P{n}=` / `P{n}-` segment in the line, in order. */
export function parseAllPnCardReplies(text: string): Array<{ index: number; rest: string }> {
  const trimmed = text.trim();
  const re = /P(\d+)\s*[:=\-]\s*([\s\S]*?)(?=P\d+\s*[:=\-]|$)/gi;
  const out: Array<{ index: number; rest: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    const index = parseInt(m[1]!, 10);
    if (!Number.isFinite(index) || index < 1) continue;
    out.push({ index, rest: (m[2] ?? "").trim() });
  }
  return out;
}

/** Parse `/reject-permission` (alias `/rp`). */
export function parseRejectPermissionCommand(text: string): RejectPermissionCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/reject-permission" || trimmed === "/rp") {
    return { kind: "reject-permission" };
  }
  return null;
}

/**
 * Detect an unknown leading-slash command for the hint reply.
 *
 * Returns null for a name this plugin owns. "/help fuck" answering "未知命令
 * /help" is the one reply guaranteed to be wrong — the user is literally
 * asking for help — and the same holds for a documented command with a bad
 * argument (`/model foo`), where `commandUsageHint` answers instead.
 */
export function detectUnknownSlashCommand(text: string): string | null {
  const m = text.trim().match(/^\/[a-zA-Z][a-zA-Z0-9-]*/);
  if (!m) return null;
  return LOCAL_COMMAND_NAMES.has(m[0].slice(1).toLowerCase()) ? null : m[0];
}

/**
 * Usage line for a DOCUMENTED command whose arguments did not parse.
 *
 * `/model foo` is not an unknown command — `/model` is printed in the `/help`
 * listing, so answering "未知命令 /model" contradicts what the user just read.
 * The command exists; the argument is wrong, and the reply has to say which
 * argument it wanted. Bare commands never reach here (every parser handles
 * them), and `/help <文字>` is excluded because that is a question for the
 * agent, not a syntax error.
 */
export function commandUsageHint(text: string): string | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/([a-zA-Z][a-zA-Z0-9-]*)\s+([\s\S]*)$/);
  if (!m) return null;
  const entry = findHelpEntry(m[1]!);
  if (!entry) return null;
  if (entry.id === "help") return null;
  return `⚠️ 用法: ${entry.usage}`;
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

/**
 * Rows shown by a numbered list command (`/s list`, `/workspace list`)
 * when the caller does not ask for more. `all` (or an explicit larger
 * number) lifts the window; the default is deliberately small because
 * WeChat splits a long reply into 4000-char messages and only 10 of
 * those fit in one gateway window.
 */
export const LIST_DEFAULT = 20;

export type WorkspaceCommand =
  | { kind: "list"; limit?: number; all?: boolean }
  | { kind: "status" }
  | { kind: "switch"; target: string }
  | { kind: "add"; path: string };

export type SessionCommand =
  | { kind: "list"; scope?: "current"; limit?: number; all?: boolean }
  | { kind: "switch"; index: number; scope?: "current" }
  | { kind: "new" }
  | { kind: "status" }
  | { kind: "pin"; index?: number }
  | { kind: "unpin"; index?: number };

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
 * Parse the trailing `[all|<count>]` of a list command.
 *
 * Grammar (shared by `/s list` and `/workspace list`):
 *   (nothing)      → default window (caller applies LIST_DEFAULT)
 *   50             → show 50 rows
 *   all            → show every row
 *   all 5 / 5 all  → `all` wins (an explicit count alongside it is not an error)
 *
 * Returns `undefined` for anything else — `0`, `abc`, a repeated token, or
 * trailing garbage — so the caller can fall through to the unknown-command
 * hint and forward the text to the agent instead of guessing.
 */
function parseListLimit(tokens: string[]): { limit?: number; all?: boolean } | undefined {
  let all = false;
  let limit: number | undefined;
  for (const token of tokens) {
    if (/^all$/i.test(token)) {
      if (all) return undefined;
      all = true;
      continue;
    }
    if (/^\d+$/.test(token)) {
      if (limit !== undefined) return undefined;
      const n = parseInt(token, 10);
      if (!Number.isFinite(n) || n <= 0) return undefined;
      limit = n;
      continue;
    }
    return undefined;
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(all ? { all: true } : {}),
  };
}

/**
 * Parse `/workspace` (alias `/ws`):
 *   (bare) | list [all|<数量>] | status | switch <path|n> | add <path>
 *
 * Bare `/ws` reports status, the same shape every other management command
 * uses (`/reasoning`, `/enter`, `/notify`, `/surface`). It used to parse to
 * `null`, which made the bridge answer "未知命令 /workspace" for a command the
 * `/help` listing documents two lines above — the most confusing possible
 * reply, because the user just read the name there.
 */
export function parseWorkspaceCommand(text: string): WorkspaceCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:workspace|ws)(?:\s+(list|status|switch|add)(?:\s+(.*))?)?$/);
  if (!m) return null;
  if (!m[1]) return { kind: "status" };
  const sub = m[1] as "list" | "status" | "switch" | "add";
  const rest = (m[2] ?? "").trim();
  switch (sub) {
    case "status":
      return { kind: sub };
    case "list": {
      const window = parseListLimit(rest ? rest.split(/\s+/) : []);
      return window === undefined ? null : { kind: "list", ...window };
    }
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
 *   list [current] [all|<数量>] | switch [current] <n> | new | status
 *   | pin [编号] | unpin [编号]
 *
 * `switch current <n>` selects the same current-working-directory scope as
 * `list current`; the explicit scope keeps the command deterministic instead
 * of relying on a hidden "last list" state. The window tokens may appear on
 * either side of `current` (`list current 50` / `list 50 current`).
 *
 * `pin` / `unpin` carry an optional row number from the latest `/s list`
 * (same numbering `switch` uses). Without one they act on the user's
 * currently bound session, so a bare `/s pin` needs no list first.
 */
export function parseSessionCommand(text: string): SessionCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:session|s)(?:\s+(list|switch|new|status|pin|unpin)(?:\s+(.*))?)?$/);
  if (!m) return null;
  // Bare `/s` reports status, like every other management command.
  if (!m[1]) return { kind: "status" };
  const sub = m[1] as "list" | "switch" | "new" | "status" | "pin" | "unpin";
  const rest = (m[2] ?? "").trim();
  switch (sub) {
    case "list": {
      const tokens = rest ? rest.split(/\s+/) : [];
      let scope: "current" | undefined;
      const windowTokens: string[] = [];
      for (const token of tokens) {
        if (token === "current" && scope === undefined) {
          scope = "current";
          continue;
        }
        windowTokens.push(token);
      }
      const window = parseListLimit(windowTokens);
      if (window === undefined) return null;
      return { kind: "list", ...(scope ? { scope } : {}), ...window };
    }
    case "new":
    case "status":
      return { kind: sub };
    case "pin":
    case "unpin": {
      if (!rest) return { kind: sub };
      if (!/^\d+$/.test(rest)) return null;
      return { kind: sub, index: parseInt(rest, 10) };
    }
    case "switch": {
      const scoped = rest.match(/^current\s+(\d+)$/);
      if (scoped) {
        return { kind: "switch", index: parseInt(scoped[1]!, 10), scope: "current" };
      }
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
  const m = trimmed.match(/^\/(?:preset|p|agent|a)(?:\s+(list|switch|status)(?:\s+(.*))?)?$/);
  if (!m) return null;
  if (!m[1]) return { kind: "status" };
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
 *
 * `switch` keeps the rest of the line intact — OpenRouter-style model ids
 * contain `/` (`inclusionai/ling-3.0-flash-fin:free`), so the provider
 * split happens later against the known provider list. A missing target
 * still parses so the handler can print usage instead of forwarding.
 */
export function parseModelCommand(text: string): ModelCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:model)(?:\s+(list|switch|status)(?:\s+(.*))?)?$/);
  if (!m) return null;
  // Bare `/model` reports the current model — the single most likely thing a
  // user types, and it used to be answered with "未知命令 /model".
  if (!m[1]) return { kind: "status" };
  const sub = m[1] as "list" | "switch" | "status";
  const rest = (m[2] ?? "").trim();
  switch (sub) {
    case "status":
      return { kind: "status" };
    case "list":
      return { kind: "list", ...(rest ? { provider: rest } : {}) };
    case "switch":
      return { kind: "switch", target: rest };
  }
}

/**
 * Split `provider/model` after a known provider id or name. Model ids may
 * themselves contain `/`, so this is not `split("/")[0]`.
 *
 * Longest matching prefix wins (`foo-bar/x` beats `foo` if both exist).
 * Returns null when no known provider owns the first segment.
 */
export function splitProviderModelTarget(
  target: string,
  providers: ReadonlyArray<{ id: string; name?: string }>,
): { provider: string; model: string } | null {
  const trimmed = target.trim();
  if (!trimmed.includes("/")) return null;
  let best: { provider: string; model: string; len: number } | null = null;
  for (const p of providers) {
    const keys = [p.id, p.name].filter((k): k is string => typeof k === "string" && k.length > 0);
    for (const key of keys) {
      const prefix = `${key}/`;
      if (!trimmed.startsWith(prefix)) continue;
      const model = trimmed.slice(prefix.length);
      if (!model) continue;
      if (!best || key.length > best.len) {
        best = { provider: p.id, model, len: key.length };
      }
    }
  }
  return best ? { provider: best.provider, model: best.model } : null;
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
  const m = trimmed.match(/^\/(?:perm|permission)(?:\s+(list|status|switch|default)(?:\s+(.*))?)?$/);
  if (!m) return null;
  if (!m[1]) return { kind: "status" };
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

export type HistoryCommand = { kind: "history"; count: number; includeSystem: boolean };

// ─── /at: reference another session or a file ───────────────────────────────

/**
 * `/at` (引用) — the WeChat stand-in for the GUI composer's `@` completion.
 *
 * WeChat has no composer attachment surface, so a reference cannot be
 * inserted at a caret. Instead `/at` STAGES a reference and the next message
 * delivered to the agent carries it: the model then sees the same tokens the
 * GUI would have produced (`@[标题](dsh-session:…)` for a session, `@path` /
 * `@"path with spaces"` for a file).
 *
 *   /at                      → list what is staged
 *   /at s <编号|关键词>       → stage another session (by /s list row or a substring)
 *   /at f <路径>              → stage a file or directory
 *   /at rm <编号>             → drop one staged reference
 *   /at clear                → drop every staged reference
 *
 * `target` is the raw rest-of-line: a path may contain spaces, and the caller
 * strips one pair of surrounding quotes (the `@"…"` spelling the GUI shows).
 */
export type AtCommand =
  | { kind: "list" }
  | { kind: "clear" }
  | { kind: "remove"; index: number }
  | { kind: "session"; target: string }
  | { kind: "file"; target: string };

export function parseAtCommand(text: string): AtCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/at(?:\s+(.*))?$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (!rest || /^(?:list|ls)$/i.test(rest)) return { kind: "list" };
  if (/^(?:clear|reset)$/i.test(rest)) return { kind: "clear" };
  const remove = rest.match(/^(?:rm|remove)\s+(\d+)$/i);
  if (remove) {
    const index = parseInt(remove[1]!, 10);
    return Number.isFinite(index) && index > 0 ? { kind: "remove", index } : null;
  }
  const sub = rest.match(/^(s|session|f|file)(?:\s+([\s\S]*))?$/i);
  if (!sub) return null;
  const target = (sub[2] ?? "").trim();
  return sub[1]!.toLowerCase().startsWith("s")
    ? { kind: "session", target }
    : { kind: "file", target };
}

/**
 * True if text looks like an `/at` attempt (including an invalid argument),
 * used to decide whether to show usage instead of forwarding to the agent —
 * the same contract as {@link isHistoryCommandAttempt}.
 */
export function isAtCommandAttempt(text: string): boolean {
  return /^\s*\/at\b/i.test(text);
}

/**
 * Parse `/history [all] [N]` — view recent conversation history.
 *   /history            → 5 human+assistant turns (default)
 *   /history 10         → 10
 *   /history all        → 5, including synthesized system injections
 *   /history all 10     → 10, including system
 *   /history 10 all     → same as `all 10`
 *   /history 30         → 20 (clamped to HISTORY_MAX)
 *
 * Returns null for: invalid tokens, non-integer / <=0 counts, extra
 * trailing garbage, or a non-history prefix. The caller detects a
 * leading `/history` with an invalid arg and replies with usage
 * instead of forwarding to the agent.
 */
export function parseHistoryCommand(text: string): HistoryCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/history(?:\s+(.*))?$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (!rest) return { kind: "history", count: HISTORY_DEFAULT, includeSystem: false };

  const tokens = rest.split(/\s+/);
  let includeSystem = false;
  let countToken: string | undefined;
  for (const token of tokens) {
    if (/^all$/i.test(token)) {
      if (includeSystem) return null;
      includeSystem = true;
      continue;
    }
    if (/^\d+$/.test(token)) {
      if (countToken !== undefined) return null;
      countToken = token;
      continue;
    }
    return null;
  }

  if (countToken === undefined) {
    return { kind: "history", count: HISTORY_DEFAULT, includeSystem };
  }
  const n = parseInt(countToken, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { kind: "history", count: Math.min(n, HISTORY_MAX), includeSystem };
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
 * Card-specific commands (`/rq`, leftover `/rp`) are intentionally
 * excluded so they keep card semantics. `/help` is
 * included: its only effect is "print the help text", which
 * `handleMessage` already handles; the card handlers' two duplicate
 * `parseHelpCommand` branches become dead code once `/help` bypasses.
 *
 * Empty text returns false (the empty-text card hint still fires).
 */
export function isBypassSlashCommand(text: string): boolean {
  if (!text) return false;
  return (
    // `parseHelpCommand` returns `true` for the listing, `{ topic }` for
    // `/help <命令>`, and `{ unknown }` for `/help <不存在的名字>`; all three
    // are help requests and bypass a pending card, so compare against `false`
    // instead of truthiness (an object here would make this function's return
    // type leak a non-boolean).
    parseHelpCommand(text) !== false ||
    parseNextCommand(text) ||
    parseFlushCommand(text) ||
    parseSilentCommand(text) !== null ||
    parseFinalCommand(text) !== null ||
    parseMergeCommand(text) !== null ||
    parseMediaCommand(text) !== null ||
    parseSurfaceCommand(text) !== null ||
    parseStatusCommand(text) !== null ||
    parseWorkspaceCommand(text) !== null ||
    parseSessionCommand(text) !== null ||
    parsePresetCommand(text) !== null ||
    parseModelCommand(text) !== null ||
    parsePermCommand(text) !== null ||
    parseReasoningCommand(text) !== null ||
    parseEnterCommand(text) !== null ||
    parseNotifyCommand(text) !== null ||
    parseHistoryCommand(text) !== null ||
    // `/at` bypasses on the ATTEMPT, not just a valid parse: a mistyped
    // `/at s` is never a plausible answer to a permission/question card, and
    // swallowing it as one would both drop the user's intent and leave the
    // card's own semantics untouched. `/history` keeps the stricter
    // valid-parse rule it has always had.
    isAtCommandAttempt(text) ||
    parseStopCommand(text) !== null
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
  // `/h` is a documented alias of `/help` (see `parseHelpCommand`). It has to
  // be listed here too: `tryNativeCommand` runs BEFORE the local `/help`
  // branch, so without it a host command named `h` would silently shadow the
  // alias — the user types `/h` and gets someone else's command.
  "h",
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
  "final",
  "fo",
  "merge",
  "mg",
  "media",
  "md",
  "surface",
  "wxprompt",
  "stop",
  "next",
  "flush",
  "f",
  "history",
  "at",
  "rp",
  "reject-permission",
  "rq",
  "reject-question",
  "notify",
  "watch",
  "notice",
]);

/**
 * Terminal display width of one code point: 2 for full-width CJK, 1 otherwise.
 *
 * Used to align the help tables. WeChat renders a fenced block in a monospace
 * box, where a CJK glyph occupies exactly two ASCII columns — padding by
 * `String.length` would leave the columns visibly ragged.
 */
function charWidth(code: number): number {
  if (code < 0x1100) return 1;
  return code === 0x2018 || code === 0x2019 || code === 0x201c || code === 0x201d
    ? 2
    : code >= 0x1100 &&
        (code <= 0x115f ||
          code === 0x2329 ||
          code === 0x232a ||
          (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
          (code >= 0xac00 && code <= 0xd7a3) ||
          (code >= 0xf900 && code <= 0xfaff) ||
          (code >= 0xfe30 && code <= 0xfe6f) ||
          (code >= 0xff00 && code <= 0xff60) ||
          (code >= 0xffe0 && code <= 0xffe6) ||
          (code >= 0x1f300 && code <= 0x1f9ff) ||
          (code >= 0x20000 && code <= 0x3fffd))
      ? 2
      : 1;
}

/** Display width of a whole string (see {@link charWidth}). */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** Right-pad `text` to `width` display columns (never truncates). */
function padTo(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/**
 * Render `[head, note]` pairs as an aligned monospace table inside a fence.
 *
 * Why a fence instead of a Markdown list: a WeChat bubble does not scroll
 * horizontally, so a long `- `/s switch 3` — …` line WRAPS, and the wrap lands
 * in the middle of the backticked command (`…（编号看 /` + `s list）`), which
 * turns one copy-pasteable line into two broken halves. A fenced block renders
 * in the scrollable monospace box the client already uses for code, so each
 * row stays on one line.
 */
function fenceTable(rows: ReadonlyArray<readonly [string, string]>, indent = 0): string[] {
  const width = rows.reduce((max, [head]) => Math.max(max, displayWidth(head)), 0);
  const pad = " ".repeat(indent);
  const out = ["```"];
  for (const [head, note] of rows) out.push(`${pad}${padTo(head, width)}  ${note}`.trimEnd());
  out.push("```");
  return out;
}

/** The /help reply, optionally augmented with native command descriptors. */
export function formatHelp(
  nativeCommands?: ReadonlyArray<{ name: string; description?: string; input?: { hint?: string } }>,
): string {
  const catalog = helpCatalog();
  const rows: Array<[string, string]> = [];
  for (const entry of catalog.commands) {
    const alias = entry.aliases.length > 0 ? ` (${entry.aliases.join(", ")})` : "";
    rows.push([`${entry.command}${alias}`, entry.summary]);
    if (entry.subcommands.length > 0) {
      const short = shortestSpelling(entry);
      // The subcommand row hangs under its command, aligned with the notes.
      rows.push(["", entry.subcommands.map((sub) => `${short} ${sub}`).join("、")]);
    }
  }
  const native: Array<[string, string]> = [];
  for (const cmd of nativeCommands ?? []) {
    if (LOCAL_COMMAND_NAMES.has(cmd.name)) continue;
    const desc = cmd.description?.trim() || "(未提供说明)";
    const hint = cmd.input?.hint ? `  ${cmd.input.hint}` : "";
    native.push([`/${cmd.name}${hint}`, desc]);
  }
  const lines: string[] = [
    "# DSH 微信助手 · 指令帮助",
    "",
    "查看某条命令的例子：`/help s`、`/help workspace`",
    "",
    ...fenceTable(rows),
  ];
  if (native.length > 0) {
    // The native section keeps its own `── … ──` banner and `• /name` rows:
    // it is generated from the host's descriptors, not from this catalog.
    lines.push(
      "",
      "```",
      "── DSH 原生命令（当前 profile 已注册）──",
      ...native.map(([head, desc]) => `• ${head} — ${desc}`),
      "```",
    );
  }
  lines.push("", "其他 /xxx 会作为文本转给 agent。");
  return lines.join("\n");
}

/**
 * One command's full example list, for WeChat `/help <命令>`.
 *
 * Every example the settings panel shows is listed here too, in the same order
 * and with the same `note` — so a user who reads `/help s` in WeChat sees
 * exactly what the panel's `/session` row expands to.
 *
 * @param topic Command name or any alias, with or without the leading slash.
 * @returns The block, or `null` when `topic` is not a documented command (the
 *   caller then shows the listing instead of inventing an answer).
 */
export function helpTopicBlock(topic: string): string | null {
  const entry = findHelpEntry(topic);
  if (!entry) return null;
  const lines: string[] = [`# ${entry.command} — ${entry.summary}`];
  if (entry.aliases.length > 0) {
    const aliases = entry.aliases.map((alias) => `\`/${alias}\``).join("、");
    lines.push("", `也可以写成：${aliases}`);
  }
  const rows = entry.examples.map(
    (example) => [example.line, example.note] as readonly [string, string],
  );
  lines.push("", ...fenceTable(rows), "", "发 `/help` 看其它命令。");
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
