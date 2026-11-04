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
import type { StatusMode, WorkStepsMode } from "../config.js";

export type HelpCommand = { kind: "help" };
export type StatusCommand = { kind: "status"; mode?: StatusMode };
/** 工作步骤展示: bare `/steps` is status; otherwise one of the three modes. */
export type WorkStepsCommand = { kind: "steps"; mode: WorkStepsMode | "status" };
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
/**
 * `/raw` — 强制透传开关.
 *
 * While this is on, EVERY inbound text goes to the agent verbatim: native
 * dispatch, every local parser, the mistyped-command usage reply, the
 * unknown-command hint and the `LOCAL_COMMAND_NAMES` shadowing all stand down.
 * The one exception is the command that turns it back off, because otherwise
 * the only way out would be restarting the plugin.
 *
 * `once` is the one-shot form: the NEXT message is passed through and the
 * switch turns itself off. That covers "paste this one `/xxx` to the model"
 * without leaving a mode on by accident — which matters because while it is on
 * the bridge stops answering commands, and a user who forgot would think the
 * bot broke.
 */
export type RawCommand = { kind: "raw"; mode: "on" | "off" | "status" | "once" };
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
  | WorkStepsCommand
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

/**
 * Parse `/status` — bare for a report, `brief` / `full` to switch how much of
 * the trailing 「会话级状态」 section is printed.
 *
 * The switch is spelled exactly like every other local toggle (`/merge off`):
 * a lowercase English word, no Chinese aliases. `/status now`
 * stays unparsed on purpose — it is not a mode, and answering it with the
 * usage line is better than silently treating it as a report request.
 */
export function parseStatusCommand(text: string): StatusCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/status") return { kind: "status" };
  const m = trimmed.match(/^\/status\s+(brief|full)\s*$/);
  if (!m) return null;
  return { kind: "status", mode: m[1] as StatusMode };
}

/**
 * Parse `/steps` — view or switch 工作步骤展示.
 *
 * Bare command defaults to status. Chinese and English mode names are both
 * accepted so a user who reads either the settings page or the docs can type
 * what they remember.
 */
export function parseWorkStepsCommand(text: string): WorkStepsCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/steps") return { kind: "steps", mode: "status" };
  const m = trimmed.match(/^\/steps\s+(.+)$/);
  if (!m) return null;
  const arg = m[1]!.trim();
  if (arg === "status") return { kind: "steps", mode: "status" };
  const modes = new Map<string, WorkStepsMode>([
    ["极简", "minimal"],
    ["minimal", "minimal"],
    ["简洁", "concise"],
    ["concise", "concise"],
    ["标准", "standard"],
    ["standard", "standard"],
  ]);
  const mode = modes.get(arg);
  return mode ? { kind: "steps", mode } : null;
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

/**
 * Parse `/raw` (alias `/passthru`) — 强制透传开关.
 *
 *   /raw             → status
 *   /raw on | off    → toggle
 *   /raw once        → pass through the NEXT message, then turn itself off
 *
 * The name has to be recognized even while the switch is ON — otherwise the
 * switch would be a one-way door — so `parseRawCommand` is the one parser the
 * passthrough bypass deliberately consults (see `isPassthroughCommand`).
 *
 * `/passthru` is the documentation-friendly synonym: "raw" alone reads like a
 * rendering mode, while "passthru" says what it does to the command layer.
 */
export function parseRawCommand(text: string): RawCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/raw" || trimmed === "/passthru") {
    return { kind: "raw", mode: "status" };
  }
  const m = trimmed.match(/^\/(?:raw|passthru)\s+(on|off|status|once)\s*$/);
  if (!m) return null;
  return { kind: "raw", mode: m[1] as "on" | "off" | "status" | "once" };
}

/**
 * True when `text` is the `/raw` command ITSELF, in any of its forms.
 *
 * The passthrough gate uses this to let the escape hatch through: with `/raw
 * on` active, every other line bypasses the bridge, but the line that says
 * `/raw off` must still be read as a command — otherwise turning it off would
 * require editing state.json.
 *
 * Deliberately narrower than `parseRawCommand` returning anything: a BARE
 * `/raw` (status query) also counts, because a user checking "is it on?" while
 * it is on should get an answer, not a forwarded `/raw`.
 */
export function isRawCommandText(text: string): boolean {
  return parseRawCommand(text) !== null;
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
 * Parse `/flush` (alias `/f`) — deliver whatever 极简模式 is currently
 * holding, without waiting for the quiescence timer. This is the
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
 * Long spellings the parsers accept but `/help` deliberately does not print.
 *
 * `HelpCommandEntry.aliases` holds SHORTENINGS only (`/s`, `/ws`, `/md`), so a
 * synonym such as `/permission` or `/busy` is parsed by its command and shown
 * by no row at all. Without this map a typo in one of those (`/permission
 * bogus`) would resolve to nothing and fall through to the agent.
 */
const COMMAND_SYNONYMS: Readonly<Record<string, string>> = {
  agent: "preset",
  permission: "perm",
  busy: "enter",
  watch: "notify",
  notice: "notify",
  wxprompt: "surface",
  "reject-question": "rq",
};

/**
 * Usage line for the card commands `/help` does not catalog.
 *
 * `/rp` is documented only as a clause inside `/rq`'s usage, so
 * `findHelpEntry("rp")` cannot answer a typo. Hard-coded rather than added to
 * the catalog, because a `/rp` row would print a second card row that says
 * almost the same thing as `/rq`.
 */
const CARD_COMMAND_USAGE: Readonly<Record<string, string>> = {
  rp: "/rp（只拒绝当前会话的权限卡；/rq 关闭全部卡片）",
  "reject-permission": "同 /rp",
};

/**
 * Minimum spelling length that may be glued to its argument (`/workspacelist`).
 *
 * A short prefix (`/s`, `/ws`, `/at`) is only accepted in front of an EXACT
 * subcommand (`/wslist`, `/atrm`): the shorter the name, the more English words
 * start with it, and a heuristic that answers instead of forwarding must not
 * claim `/stats` or `/such-and-such`.
 */
const GLUE_MIN_NAME = 3;

/**
 * Levenshtein distance, capped: anything above `limit` returns `limit + 1`.
 *
 * Only used to ask "is this a typo of that subcommand" (`lsit` → `list`), so
 * the exact distance above 2 never matters.
 */
function editDistance(a: string, b: string, limit = 2): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/** What a mistyped line resolves to: enough to answer it without the agent. */
interface LocalCommandRef {
  /** The spelling the reply shows (`/s`, not `/session`). */
  command: string;
  /**
   * The canonical long spelling (`/session`).
   *
   * Used when the reply has to name the command the user probably MEANT: a
   * typo like `/sessoin` is closer to the long name, so answering "你是想发 /s
   * 吗" points at the wrong shape even though both run the same handler.
   */
  fullCommand: string;
  /** The catalog's grammar line. */
  usage: string;
  /** `/help <topic>` for the catalog entry, when it has one. */
  topic?: string;
  /** Two copyable examples (never the `..` / `!!` text rows). */
  examples: string[];
  /** First token of every documented subcommand, lowercased. */
  subcommandHeads: string[];
}

/**
 * Resolve one slash name to the command the bridge owns, or `null`.
 *
 * `/help` is deliberately absent: `/help <任何文字>` is a help request whose
 * own branch answers with the listing, so it must never be reported as a
 * mistyped command line.
 */
function lookupLocalCommandName(rawName: string): LocalCommandRef | null {
  const name = rawName.toLowerCase();
  const synonym = COMMAND_SYNONYMS[name];
  const entry = findHelpEntry(name) ?? (synonym ? findHelpEntry(synonym) : undefined);
  if (entry) {
    if (entry.id === "help") return null;
    const command = shortestSpelling(entry);
    return {
      command,
      fullCommand: entry.command,
      usage: entry.usage,
      topic: command.slice(1),
      examples: entry.examples
        .filter((example) => (example.kind ?? "command") === "command")
        .slice(0, 2)
        .map((example) => example.line),
      subcommandHeads: [
        ...new Set(entry.subcommands.map((sub) => sub.split(/\s+/)[0]!.toLowerCase())),
      ],
    };
  }
  const usage = CARD_COMMAND_USAGE[name];
  return usage
    ? { command: `/${name}`, fullCommand: `/${name}`, usage, examples: [], subcommandHeads: [] }
    : null;
}

/**
 * Resolve a name that ran INTO its argument (`/workspacelist`, `/wslist`).
 *
 * The longest matching prefix wins, and the remainder must be EVIDENCE that
 * this really was that command: either one of its subcommands (`list`), or a
 * one-of-two-edit typo of one whose first letter matches (`lsit`). Without that
 * gate every English word starting with a command name would be claimed —
 * `/enterprise` reads as `/enter` + `prise`.
 *
 * A prefix shorter than {@link GLUE_MIN_NAME} (`/ws`, `/s`, `/at`) is stricter
 * on purpose: only an EXACT subcommand counts (`/wslist`), because `/s` and
 * `/ws` begin far too many words for a fuzzier rule to be safe.
 */
function lookupGluedLocalCommand(token: string): { ref: LocalCommandRef; rest: string } | null {
  const lower = token.toLowerCase();
  for (let cut = lower.length - 1; cut >= 1; cut--) {
    const name = lower.slice(0, cut);
    const ref = lookupLocalCommandName(name);
    if (!ref) continue;
    const rest = lower.slice(cut);
    const heads = ref.subcommandHeads;
    if (heads.length === 0) continue;
    const exact = heads.includes(rest);
    if (exact) return { ref, rest };
    if (cut < GLUE_MIN_NAME || rest.length < 3) continue;
    if (heads.some((head) => head[0] === rest[0] && editDistance(head, rest) <= 2)) {
      return { ref, rest };
    }
  }
  return null;
}

/**
 * Minimum length of a name that may be CORRECTED (`/stauts` → `/status`).
 *
 * Fuzzy matching on a short name is a guessing game: `/plan`, `/goal`, `/foo`
 * and `/etc` sit one or two edits from `perm`, `next`, `help` or `at`, and
 * answering those would break the contract that an unregistered `/xxx` may be
 * prose the model should read. The input threshold alone keeps every 4-letter
 * native name (`/plan`, `/goal`) out, because a name that SHORT is far more
 * likely to be a registered command this profile lacks than a typo.
 */
const SUGGEST_MIN_INPUT = 5;
/**
 * Minimum length of the candidate a typo may resolve to.
 *
 * 4-letter commands (`stop`, `perm`, `next`) are included so a typo that is
 * longer than its target (`/stopp` → `/stop`) is still answered — only the
 * INPUT length is gated, which is exactly what distinguishes a typo from a
 * different word.
 */
const SUGGEST_MIN_TARGET = 4;
const SUGGEST_MAX_DISTANCE = 2;

/**
 * The documented name `token` is most likely a typo of, or `null`.
 *
 * Ambiguity is a refusal: two candidates at the same distance (`/modle` sits
 * between `model` and nothing else, but a name like `/finai` could reach both
 * `flush` and `media`) means the guess is not safe enough to answer INSTEAD of
 * forwarding, so it returns `null` and the line takes the unknown-command path.
 */
function lookupTypoCorrectedName(token: string): LocalCommandRef | null {
  if (token.length < SUGGEST_MIN_INPUT) return null;
  const candidates: Array<{ ref: LocalCommandRef; distance: number }> = [];
  for (const entry of helpCatalog().commands) {
    if (entry.id === "help") continue;
    for (const spelling of [entry.command.replace(/^\//, ""), ...(entry.aliases ?? [])]) {
      const name = spelling.replace(/^\//, "").toLowerCase();
      if (name.length < SUGGEST_MIN_TARGET) continue;
      const distance = editDistance(name, token.toLowerCase(), SUGGEST_MAX_DISTANCE);
      if (distance > SUGGEST_MAX_DISTANCE) continue;
      const ref = lookupLocalCommandName(name);
      if (ref) candidates.push({ ref, distance });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0]!;
  // More than one distinct command at the best distance = no safe guess.
  if (candidates.some((c) => c.distance === best.distance && c.ref.command !== best.ref.command)) {
    return null;
  }
  return best.ref;
}

/**
 * Parse a line that named a command this bridge owns but that no parser
 * accepted — a mistyped subcommand (`/s lsit`), a bad argument
 * (`/model foo`), a missing space (`/workspacelist`), or a mistyped NAME
 * (`/stauts`).
 *
 * Returns `null` for every line a parser DID accept (`/s list`), for a help
 * request, and for a name nobody plausibly owns (`/nope`, `/plan off`).
 */
function resolveMistypedCommand(
  text: string,
): { ref: LocalCommandRef; gluedRest?: string; misspelledName?: boolean; shown: string } | null {
  if (!text) return null;
  // A line that parses is by definition not mistyped. `/at` and `/skill` are
  // checked on the ATTEMPT (see `isAtCommandAttempt` / `isSkillCommandAttempt`),
  // because their own branches answer with usage rather than forwarding.
  if (recognizesLocalCommand(text) || isAtCommandAttempt(text) || isSkillCommandAttempt(text)) {
    return null;
  }
  const trimmed = text.trim();
  const m = trimmed.match(/^\/([A-Za-z][A-Za-z0-9-]*)/);
  if (!m) return null;
  const token = m[1]!;
  const direct = lookupLocalCommandName(token);
  if (direct) return { ref: direct, shown: trimmed };
  // `/models`, `/sessions`, `/workspaces`, `/permissions` — a plural of a real
  // name is the same command, not a new one. Requires the singular to be a
  // command this bridge owns, so `/plans` (native, unregistered) still falls
  // through to the agent.
  if (token.length > 2 && /s$/i.test(token)) {
    const plural = lookupLocalCommandName(token.slice(0, -1));
    if (plural) return { ref: plural, misspelledName: true, shown: trimmed };
  }
  const glued = lookupGluedLocalCommand(token.toLowerCase());
  if (glued) return { ref: glued.ref, gluedRest: glued.rest, shown: trimmed };
  // The name itself is misspelled — answer with the command it probably meant.
  const corrected = lookupTypoCorrectedName(token);
  if (corrected) return { ref: corrected, misspelledName: true, shown: trimmed };
  return null;
}

/**
 * True when one of the bridge's OWN parsers accepts `text`.
 *
 * The list is written out rather than reusing `isBypassSlashCommand` because
 * the two answer different questions: bypass excludes the card commands
 * (`/rq`, `/rp`) and matches `/at` on the attempt, while this has to mean
 * "some handler will run". Ordering inside the caller is irrelevant, which is
 * the point — `resolveMistypedCommand` runs BEFORE the dispatch chain, so it
 * must not depend on which branch would have won.
 */
function recognizesLocalCommand(text: string): boolean {
  return (
    parseHelpCommand(text) !== false ||
    parseNextCommand(text) ||
    parseFlushCommand(text) ||
    parseStatusCommand(text) !== null ||
    parseWorkStepsCommand(text) !== null ||
    parseMergeCommand(text) !== null ||
    parseMediaCommand(text) !== null ||
    parseSurfaceCommand(text) !== null ||
    parseRawCommand(text) !== null ||
    parseStopCommand(text) !== null ||
    parseNotifyCommand(text) !== null ||
    parseRejectQuestionCommand(text) !== null ||
    parseRejectPermissionCommand(text) !== null ||
    parseWorkspaceCommand(text) !== null ||
    parseSessionCommand(text) !== null ||
    parsePresetCommand(text) !== null ||
    parseModelCommand(text) !== null ||
    parsePermCommand(text) !== null ||
    parseReasoningCommand(text) !== null ||
    parseEnterCommand(text) !== null ||
    parseHistoryCommand(text) !== null ||
    parseForkCommand(text) !== null ||
    parseAtCommand(text) !== null ||
    parseSkillCommand(text) !== null
  );
}

/**
 * True when `text` names a command this bridge owns but is not a valid line
 * for it — `/s lsit`, `/workspacelist`, `/model foo`.
 *
 * Used by {@link isBypassSlashCommand}: a mistyped command is still the user
 * typing a command, so a pending question/approval card must not swallow it as
 * a free-text answer. The reply is the usage line, sent by `handleMessage`.
 */
export function isMistypedLocalCommand(text: string): boolean {
  return resolveMistypedCommand(text) !== null;
}

/** Truncate a quoted line for a reply without splitting a surrogate pair. */
function quoteForHint(text: string, limit = 60): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit - 1).join("") + "…";
}

/**
 * The reply for a command line the bridge owns but could not execute.
 *
 * `/model foo` is not an unknown command — `/model` is printed in the `/help`
 * listing, so answering "未知命令 /model" contradicts what the user just read.
 * The command exists; the argument does not, so the reply quotes the line, the
 * grammar, two copyable examples, and the `/help <命令>` pointer.
 *
 * The caller must NOT forward the line afterwards: a mistyped command sent to
 * the agent costs a whole turn of prose the user has to talk their way out of,
 * which is exactly the polluted context this reply exists to prevent.
 */
export function commandUsageHint(text: string): string | null {
  const resolved = resolveMistypedCommand(text);
  if (!resolved) return null;
  const { ref, gluedRest, misspelledName, shown } = resolved;
  const quoted = quoteForHint(shown);
  const opening = gluedRest
    ? `⚠️ 没看懂「${quoted}」——是 ${ref.command} ${gluedRest} 少了空格吗？这条消息没有转发给 agent。`
    : misspelledName
      ? `⚠️ 没有 ${quoted.split(/\s+/)[0]} 这条命令，你是想发 ${ref.fullCommand} 吗？这条消息没有转发给 agent。`
      : `⚠️ 没看懂「${quoted}」——这条消息没有转发给 agent。`;
  const lines: string[] = [opening, `用法: ${ref.usage}`];
  if (ref.examples.length > 0) lines.push(`例: ${ref.examples.join("、")}`);
  if (ref.topic) lines.push(`发 /help ${ref.topic} 看全部例子。`);
  return lines.join("\n");
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
  /** Switch the preset of the bound session (allowed only before its first turn). */
  | { kind: "switch"; target: string }
  /** Read or write the deployment default preset (new sessions from now on). */
  | { kind: "default"; target?: string }
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
 * Parse the single row number a `show` / `switch` subcommand takes.
 *
 * Exactly one positive integer and nothing else: `show 1 2` and `show abc` are
 * usage errors, never a guess. Shared by `/fork show`, `/fork switch` and
 * `/history show`, so the three agree on what a number means — and on when it
 * is not one.
 */
function parseTurnIndex(tokens: string[]): number | undefined {
  if (tokens.length !== 1 || !/^\d+$/.test(tokens[0]!)) return undefined;
  const index = parseInt(tokens[0]!, 10);
  return Number.isFinite(index) && index > 0 ? index : undefined;
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
 *   list | switch <名称|编号> | default [名称|编号] | status
 *
 * Two different facts, two different subcommands:
 *
 *   - `switch` is SESSION-scoped: it changes the preset the bound session runs,
 *     through the host's own `agentPresets.select`. DSH only allows that before
 *     the session's first turn, which is why a started session is refused
 *     rather than silently switched for "later".
 *   - `default` is DEPLOYMENT-scoped: it writes the DSH settings document
 *     (`agent-preset-registry.selectedDefault`, legacy `agent-presets.default`)
 *     — the same default the GUI settings page edits, so both sides stay in
 *     sync and every NEW session picks it up.
 */
export function parsePresetCommand(text: string): PresetCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/(?:preset|p|agent|a)(?:\s+(list|switch|status|default)(?:\s+(.*))?)?$/);
  if (!m) return null;
  if (!m[1]) return { kind: "status" };
  const sub = m[1] as "list" | "switch" | "status" | "default";
  const rest = (m[2] ?? "").trim();
  switch (sub) {
    case "list":
    case "status":
      return { kind: sub };
    case "switch":
      if (!rest) return null;
      return { kind: "switch", target: rest };
    case "default":
      // Bare `/preset default` reports the current default, like `/perm default`.
      return { kind: "default", ...(rest ? { target: rest } : {}) };
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

/**
 * Rows `/history` prints when the caller does not ask for more.
 *
 * Smaller than {@link LIST_DEFAULT} on purpose: `/history` answers "what did we
 * just say", and five turns is roughly one screen of WeChat. The window can be
 * lifted with `list <数量>` / `list all`, exactly like `/fork list`.
 */
export const HISTORY_DEFAULT = 5;

/**
 * `/history`（回看）— 按轮次回看当前会话，与 `/fork` 同一套折叠。
 *
 *   /history                   → 同 `/history list`
 *   /history list [all|数量]   → 每轮一行（默认最近 5 轮），末轮全文
 *   /history show <编号>       → 第 N 轮的完整提问与完整回复
 *
 * 每轮只保留「该轮第一条人类提示词 + 该轮最终回复」：过程中间的助手消息
 * （工具调用前后的碎句）不再出现——那不是这一轮说了什么，而是它怎么说的。
 * 折叠来自 `ops.readSessionTurns()`，与 `/fork` 逐字同源，所以两个命令对同一份
 * 日志给出的编号永远一致，`show N` 看到的是同一轮。
 *
 * `list` 的窗口语法与 `/fork list`、`/s list` 完全一致（同一个
 * {@link parseListLimit}）：`all` 现在是「全部轮次」，不再是旧版的「含系统
 * 消息」——注入类消息（压缩检查点 / 插件上下文 / goal 续跑）本来就不该出现在
 * 「你说过什么」的列表里。
 */
export type HistoryCommand =
  | { kind: "list"; limit?: number; all?: boolean }
  | { kind: "show"; index: number };

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
 * used to decide whether to show usage instead of forwarding to the agent.
 */
export function isAtCommandAttempt(text: string): boolean {
  return /^\s*\/at\b/i.test(text);
}

/**
 * Parse `/history [list [all|数量] | show <编号>]`.
 *
 * Mirrors {@link parseForkCommand} minus `switch`: the same window grammar
 * (`parseListLimit`), the same "exactly one positive integer" rule for `show`,
 * and the same refusal to guess at anything else.
 *
 * The old spellings are deliberately gone: `/history 10` (bare count) and
 * `/history all` (system messages) both fail closed here, and the usage reply
 * teaches `list 10` / `list all` instead of quietly meaning something a `/fork`
 * user would not expect.
 */
export function parseHistoryCommand(text: string): HistoryCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/history(?:\s+(.*))?$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (!rest) return { kind: "list" };
  const [head, ...tail] = rest.split(/\s+/);
  switch (head!.toLowerCase()) {
    case "list": {
      const window = parseListLimit(tail);
      return window === undefined ? null : { kind: "list", ...window };
    }
    case "show": {
      const index = parseTurnIndex(tail);
      return index === undefined ? null : { kind: "show", index };
    }
    default:
      return null;
  }
}

// ─── /fork: 按轮次分叉当前会话 ──────────────────────────────────────────────

/**
 * `/fork`（分叉）— 以当前会话的某一轮为切点开一个新会话。
 *
 *   /fork                      → 同 `/fork list`
 *   /fork list [all|<数量>]    → 轮次列表（默认 20 行，并显示「共 N 轮」「显示 20/37」）
 *   /fork show <编号>          → 第 N 轮的完整提问与完整回复
 *   /fork switch <编号>        → 从第 N 轮末尾分叉，并把微信绑定切到新会话
 *
 * `list` 的窗口语法与 `/s list`、`/workspace list` 完全一致（同一个
 * {@link parseListLimit}），所以 `all` / 数字 / `all 5` 的行为逐字相同。详情因此
 * 单独占 `show` 一个子命令：`list 5` 永远是「看 5 行」，不会和「看第 5 轮」混淆。
 *
 * 编号是**全表行号**（1…N），与 `/s list` 一致：窗口只影响显示，不影响解析，
 * 所以只显示 20 行时 `/fork show 25` 照样能到第 25 轮（同 `/s switch 25`）。
 */
export type ForkCommand =
  | { kind: "list"; limit?: number; all?: boolean }
  | { kind: "show"; index: number }
  | { kind: "switch"; index: number };

export function parseForkCommand(text: string): ForkCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/fork(?:\s+(.*))?$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (!rest) return { kind: "list" };
  const [head, ...tail] = rest.split(/\s+/);
  switch (head!.toLowerCase()) {
    case "list": {
      const window = parseListLimit(tail);
      return window === undefined ? null : { kind: "list", ...window };
    }
    case "show":
    case "switch": {
      const index = parseTurnIndex(tail);
      return index === undefined ? null : { kind: head!.toLowerCase() as "show" | "switch", index };
    }
    default:
      return null;
  }
}

/**
 * True if text looks like a `/fork` attempt (including an invalid argument).
 *
 * Same contract as {@link isAtCommandAttempt}: a mistyped line gets its usage
 * reply instead of being forwarded to the agent as prose.
 */
export function isForkCommandAttempt(text: string): boolean {
  return /^\s*\/fork\b/i.test(text);
}

/**
 * The turn fields the WeChat renderers read.
 *
 * Structural subset of `SessionTurn` (`src/dsh/ops.ts`) so this module keeps
 * its single dependency (the help catalog) and stays trivially unit-testable.
 * Shared by `/fork` and `/history`: both print the SAME fold, so a type named
 * after either command would misdescribe the other.
 */
export interface TurnView {
  prompt: string;
  reply: string;
  /** `turn/end` seq; absent means the turn is still running. */
  endSeq?: number;
  /** When the human spoke (`user/message` event time). */
  promptTime?: number;
  /** When the turn closed (`turn/end` event time); absent while it runs. */
  replyTime?: number;
}

/** Prompt preview budget: one WeChat line next to the row number and emoji. */
const TURN_PROMPT_PREVIEW = 30;
/** Reply preview budget: a bit more than the prompt, the reply carries the answer. */
const TURN_REPLY_PREVIEW = 50;

/**
 * Collapse one message body to a single-line preview, mirroring the GUI
 * rail's `preview()` normalization (whitespace collapsed, ellipsis when
 * clipped) at a budget sized for a WeChat bubble rather than a rail card.
 */
function turnPreview(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized === "") return "";
  const chars = Array.from(normalized);
  if (chars.length <= limit) return normalized;
  return `${chars.slice(0, limit - 1).join("").trimEnd()}…`;
}

/**
 * One side of a list row: `👤 50 分钟前 · 提问…`.
 *
 * The stamp sits BEFORE the text, not after it: the text is a preview that may
 * end in `…`, and `…（50 分钟前）` reads like part of the sentence rather than
 * metadata. A side without a stamp (a turn still running has no reply time)
 * degrades to `🤖 （进行中）` instead of printing a bare `未知时间`.
 */
function rowSide(emoji: string, epoch: number | undefined, text: string): string {
  return typeof epoch === "number"
    ? `${emoji} ${formatRelativeTime(epoch)} · ${text}`
    : `${emoji} ${text}`;
}

/**
 * A block label with its own clock: `👤 你 · 50 分钟前`.
 *
 * Prompt and reply carry SEPARATE stamps — the human's message and the answer
 * can be minutes apart, and the two questions ("when did I say it", "when did
 * it answer") deserve their own answer.
 */
function blockLabel(label: string, epoch: number | undefined): string {
  return typeof epoch === "number" ? `${label} · ${formatRelativeTime(epoch)}` : label;
}

/**
 * One list row: `N. 👤 50 分钟前 · 提示词… → 🤖 49 分钟前 · 回复…`.
 *
 * Shared by `/fork list` and `/history list`. The numbers already agree between
 * the two commands, and a different row shape would suggest they do not.
 */
function turnRow(index: number, turn: TurnView): string {
  const prompt = turnPreview(turn.prompt, TURN_PROMPT_PREVIEW) || "（无文字）";
  // A running turn has no closing event yet, which is a different fact from
  // a finished turn that produced no prose (tool-only or aborted).
  const reply = turnPreview(turn.reply, TURN_REPLY_PREVIEW)
    || (turn.endSeq === undefined ? "（进行中）" : "（无回复）");
  return `${index}. ${rowSide("👤", turn.promptTime, prompt)} → ${rowSide("🤖", turn.replyTime, reply)}`;
}

/**
 * Separator between the blocks of a turn list.
 *
 * A BLANK line, never a single `\n`. WeChat markdown-renders a bot message as
 * soon as it contains any markdown at all — one `**bold**`, one table or one
 * inline code span in the agent's reply is enough — and in that mode a single
 * newline is a SOFT break, rendered as a space. That welded `🤖 助手` onto the
 * reply, and `看全文: …` onto the reply's last line, on desktop WeChat (the
 * mobile client reflows the same way; it just wraps at a different width). A
 * blank line is a paragraph break under BOTH renderers, so the layout survives
 * whether or not the message happens to trip the markdown path.
 *
 * The cost is one extra line per block; for a five-row list that is nothing,
 * and a broken layout is far more expensive than an airy one.
 */
const BLOCK_SEPARATOR = "\n\n";

/**
 * `/fork list` — one line per turn, newest window by default.
 *
 * The window is a TAIL window (the latest turns are the interesting ones),
 * but the printed numbers stay absolute (1…N) so a row the user reads here
 * addresses the same turn in `/fork show` / `/fork switch`, and so a row
 * outside the window keeps its number.
 */
export function renderForkList(
  turns: readonly TurnView[],
  window: { limit?: number; all?: boolean } = {},
): string {
  const total = turns.length;
  if (total === 0) return "🔀 这个会话还没有已记录的轮次。";
  const limit = window.all ? total : (window.limit ?? LIST_DEFAULT);
  const shown = limit >= total ? turns : turns.slice(total - limit);
  const offset = total - shown.length;
  const blocks: string[] = [`🔀 会话轮次（共 ${total} 轮）`];
  shown.forEach((turn, position) => {
    blocks.push(turnRow(offset + position + 1, turn));
  });
  if (shown.length < total) {
    blocks.push(`显示 ${shown.length}/${total}，看更早的: /fork list all（或 /fork list <数量>）`);
  }
  const newest = offset + shown.length;
  // Point the fork example at the newest COMPLETED turn: suggesting a switch
  // on a running turn would answer the very command it printed with a refusal.
  let switchIndex: number | undefined;
  for (let position = shown.length - 1; position >= 0; position--) {
    if (shown[position]!.endSeq !== undefined) {
      switchIndex = offset + position + 1;
      break;
    }
  }
  const hints = [`看全文: /fork show ${newest}`];
  if (switchIndex !== undefined) hints.push(`从那轮分叉: /fork switch ${switchIndex}`);
  blocks.push(hints.join("；"));
  return blocks.join(BLOCK_SEPARATOR);
}

/**
 * One turn in full, for `/fork show` and `/history show`.
 *
 * Deliberately NOT truncated: the whole point of naming a turn is to read it.
 * Oversized bodies are handled downstream by `splitText` (per-message chunking)
 * and the `/next` queue.
 *
 * `emoji` is the ONLY difference between the two commands' detail views
 * (`🔀` fork, `📜` history): the body has to stay identical, because it is the
 * same turn either way, and the footer's fork hint is true from both.
 */
export function renderTurnDetail(turn: TurnView, index: number, emoji = "🔀"): string {
  const prompt = turn.prompt.trim() || "（这一轮没有文字提示词）";
  const reply = turn.reply.trim()
    || (turn.endSeq === undefined ? "（这一轮还在进行中）" : "（这一轮没有文字回复）");
  const lines = [
    `${emoji} 第 ${index} 轮`,
    "",
    blockLabel("👤 你", turn.promptTime),
    "",
    prompt,
    "",
    blockLabel("🤖 助手", turn.replyTime),
    "",
    reply,
  ];
  // The reply block already said the turn is running, so the footer only has
  // to answer the question the reader actually has: can I fork here?
  lines.push("", turn.endSeq === undefined ? "这一轮结束后才能分叉。" : `从那轮分叉: /fork switch ${index}`);
  return lines.join("\n");
}

/** `/fork show <编号>` — that turn, in full. */
export function renderForkDetail(turn: TurnView, index: number): string {
  return renderTurnDetail(turn, index, "🔀");
}

/** `/history show <编号>` — the same turn `/fork show` prints, read not forked. */
export function renderHistoryDetail(turn: TurnView, index: number): string {
  return renderTurnDetail(turn, index, "📜");
}

/**
 * The newest turn, printed as a block instead of a one-line row: label, prompt
 * and reply each get their own paragraph.
 *
 * This is the row the reader came for ("what did it just say"), so it is the
 * one place a `/history` list is allowed to be tall. Every part is separated by
 * {@link BLOCK_SEPARATOR} — see the note there for why a single newline is not
 * enough.
 */
function historyLastBlock(index: number, turn: TurnView): string {
  const prompt = turn.prompt.trim() || "（无文字）";
  const reply = turn.reply.trim()
    || (turn.endSeq === undefined ? "（进行中）" : "（无回复）");
  return [
    `${index}. ${blockLabel("👤 你", turn.promptTime)}`,
    prompt,
    blockLabel("🤖 助手", turn.replyTime),
    reply,
  ].join(BLOCK_SEPARATOR);
}

/**
 * `/history list` — the same turns `/fork list` shows, read as a transcript.
 *
 * Every row is 「你的提示词 → 该轮最终回复」; the NEWEST turn is printed in full
 * (prompt and reply, untruncated) because it is the answer the reader is most
 * likely to be looking for — "what did it just say" — and it is exactly what
 * the old flat `/history` did with the latest assistant message. The earlier
 * rows are previews only, which is what lets five turns fit in one bubble.
 *
 * The window is a TAIL window that always ends at the newest turn, so
 * `index === total` is always "the last turn" regardless of how many rows are
 * shown. Numbers stay absolute (1…N), the same coordinate `/fork` uses, so
 * `/history show 25` reaches turn 25 while only 5 rows are printed.
 */
export function renderHistoryList(
  turns: readonly TurnView[],
  window: { limit?: number; all?: boolean } = {},
): string {
  const total = turns.length;
  if (total === 0) return "📜 暂无历史消息。";
  const limit = window.all ? total : (window.limit ?? HISTORY_DEFAULT);
  const shown = limit >= total ? turns : turns.slice(total - limit);
  const offset = total - shown.length;
  const blocks: string[] = [`📜 会话轮次（共 ${total} 轮）`];
  shown.forEach((turn, position) => {
    const index = offset + position + 1;
    blocks.push(index === total ? historyLastBlock(index, turn) : turnRow(index, turn));
  });
  if (shown.length < total) {
    blocks.push(`显示 ${shown.length}/${total}，看更早的: /history list all（或 /history list <数量>）`);
  }
  blocks.push(`看全文: /history show ${total}`);
  return blocks.join(BLOCK_SEPARATOR);
}

// ─── /skill: 查看当前会话的技能 ──────────────────────────────────────────────

/**
 * `/skill`（技能）— 列出当前会话的技能，或看某一个的详细说明。
 *
 *   /skill        → 列出技能（编号 + 一句话说明）
 *   /skill 2      → 第 2 个的详细说明
 *   /skill office → 按名字看某个技能的详细说明
 *
 * **它不执行技能。** 执行技能的方式是直接把 `/技能名` 发出去：宿主
 * `dsh-tool-skill` 会扫描用户消息里的 `/名称` 手势并注入技能正文，与 GUI 里
 * 在输入框打 `/技能名` 完全同一条路。所以 `/skill` 只负责「让你知道有哪些、
 * 分别是什么」，执行交给那条本来就存在的通道。
 *
 * 由此产生的一个边界：技能名如果与 bridge 自己的命令同名（`/help`、`/status`
 * 之类），直接打 `/名字` 会被当成命令而不是手势。这时用 `/raw on` 透传即可
 * ——`/raw` 期间所有拦截全部让开，`/名字` 原样交给 agent，宿主的扫描照常生效。
 * 列表里会提示这一点。
 */
export type SkillCommand = { kind: "list" } | { kind: "show"; target: string };

/**
 * 目标：编号（正整数）或技能名（kebab-case ASCII，宿主 `isSkillName` 的语法）。
 *
 * 与 `/at` 不同，这里**没有**「目标 + 任务」的形式：`/skill` 不转发任何东西，
 * 所以整行只能是这两者之一。`/skill 1 帮我做这个事` 会被判为解析失败并回用法，
 * 而不是把后半句丢掉——静默丢字比回一句提示糟得多。
 */
const SKILL_TARGET = /^(\d+|[a-z0-9]+(?:-[a-z0-9]+)*)$/i;

export function parseSkillCommand(text: string): SkillCommand | null {
  const m = text.trim().match(/^\/skill(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (!rest) return { kind: "list" };
  if (/^(?:list|ls)$/i.test(rest)) return { kind: "list" };
  const target = rest.match(SKILL_TARGET);
  return target ? { kind: "show", target: target[1]! } : null;
}

/**
 * True if text looks like an `/skill` attempt (including an invalid argument).
 *
 * Same contract as {@link isAtCommandAttempt}: a mistyped line gets its usage
 * reply instead of being forwarded as prose.
 */
export function isSkillCommandAttempt(text: string): boolean {
  return /^\s*\/skill\b/i.test(text);
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
    parseWorkStepsCommand(text) !== null ||
    parseMergeCommand(text) !== null ||
    parseMediaCommand(text) !== null ||
    parseSurfaceCommand(text) !== null ||
    // `/raw` must bypass a pending card: it is the escape hatch, and it is
    // also the only command that works while passthrough is on.
    parseRawCommand(text) !== null ||
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
    // `/fork` follows the `/at` / `/skill` attempt rule: a mistyped subcommand
    // (`/fork shw 2`) is a command attempt, never a plausible card answer.
    isForkCommandAttempt(text) ||
    // `/at` bypasses on the ATTEMPT, not just a valid parse: a mistyped
    // `/at s` is never a plausible answer to a permission/question card, and
    // swallowing it as one would both drop the user's intent and leave the
    // card's own semantics untouched. `/history` keeps the stricter
    // valid-parse rule it has always had.
    isAtCommandAttempt(text) ||
    // `/skill` follows the same attempt rule: a mistyped argument must reach
    // `handleMessage` for its usage reply, never be submitted as a card answer.
    isSkillCommandAttempt(text) ||
    // A mistyped line for a command this bridge owns (`/s lsit`,
    // `/workspacelist`) is still a command attempt, not a free-text answer: it
    // must reach `handleMessage` to get its usage reply instead of being
    // submitted as the card's answer.
    parseStopCommand(text) !== null ||
    isMistypedLocalCommand(text)
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
  "steps",
  "merge",
  "mg",
  "media",
  "md",
  "surface",
  "wxprompt",
  "raw",
  "passthru",
  "stop",
  "next",
  "flush",
  "f",
  "history",
  "fork",
  "at",
  "skill",
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
  lines.push("", "已列出的命令写错子命令时只回用法，不转给 agent。");
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
 * @param options.mode `"full"` (default) renders every bucket; `"brief"`
 *   renders `[模式]` only. The default is `"full"` so every existing caller
 *   (and every existing test) keeps the pre-0.14 output; the bridge passes
 *   `config.statusMode` explicitly.
 * @returns Pre-formatted lines ready to be appended to `/status`.
 *   Empty when `values` has no keys with renderable output.
 */
export function renderProjectionSection(
  values: Record<string, unknown>,
  options: { mode?: StatusMode } = {},
): string[] {
  type Bucket = Array<{ key: string; lines: string[] }>;
  const buckets: Record<ProjectionGroup, Bucket> = {
    mode: [],
    usage: [],
    session: [],
    other: [],
  };

  for (const key of Object.keys(values).sort()) {
    const group = PROJECTION_GROUP[key] ?? "other";
    // Brief mode skips non-mode keys entirely: their renderers are pure and
    // cheap, but a key whose renderer would throw must not emit a warn line
    // for a bucket the user has explicitly asked not to see.
    if (options.mode === "brief" && group !== "mode") continue;
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
  // the caller appends next (the `[后台任务]` block, when this session has
  // background jobs).
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

// ─── Background jobs (`ctx.jobs`) → `[后台任务]` ──────────────────────────
//
// `/status` used to end at the projection section. DSH also runs background
// jobs (the `job_list` / `job_output` / `job_kill` family), and "something is
// still running" is exactly the kind of state a user needs BEFORE deciding to
// send another instruction — so it belongs in `/status`, in both modes.
//
// Scope: only the CURRENT session's jobs. The registry fences reads by owner
// (`list(caller)` returns the caller's jobs plus unowned ones), and an unowned
// job belongs to no conversation at all, so the bridge filters to
// `owner === sessionId` and never scans other sessions.
//
// Naming: the banner is `[后台任务]`, matching what the rows inside actually
// are. It was briefly `[后台会话]`, which described the *scope* (this session)
// rather than the *content* (background jobs) and read as if other WeChat
// sessions were listed there.

/**
 * The subset of one `JobView` the `/status` block reads.
 *
 * Declared structurally (not imported from `@deepseek-ai/*`) so the bridge
 * keeps its zero-runtime-coupling contract; the host's `JobView` is a
 * superset and fits by duck typing.
 */
export interface BackgroundJobView {
  id: string;
  kind: string;
  label: string;
  status: string;
  progress?: string;
  startedAt?: number;
}

/** How many running jobs get their own line before the rest are summarised. */
export const BACKGROUND_JOB_DETAIL_MAX = 5;

/** Statuses that still describe live work. `stopping` is winding down, not done. */
const BACKGROUND_JOB_LIVE: ReadonlySet<string> = new Set(["running", "stopping"]);

/** Compact duration for one running job (`"40s"`, `"2m"`, `"1.5h"`). */
function formatJobAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return "0s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Render the `[后台任务]` block for one session's jobs.
 *
 * Output shape (same indentation as the projection buckets, so the two blocks
 * read as one section):
 *
 * ```
 * [后台任务]
 *   • 🟢 共 3 个 · 运行中 2 个
 *     ▶ bash · npm run build（已运行 2m）
 *     ▶ bash · vitest --watch（已运行 40s） · 编译中
 * ```
 *
 * Rules:
 *   - **Empty input → `[]`.** Nothing running and nothing recorded is not news;
 *     a `共 0 个` row on every single `/status` is exactly the kind of noise
 *     「简洁」 exists to remove. The caller then prints no banner either, so a
 *     host without the `jobs` service and a host with no jobs look identical.
 *   - Jobs exist but none is running → one line, `⚪ 共 N 个`. The count is the
 *     answer to "did anything pile up?"; per-job detail is only useful while
 *     something is alive.
 *   - More than {@link BACKGROUND_JOB_DETAIL_MAX} running jobs → the first N
 *     (oldest first) plus `… 另有 M 个运行中`.
 *   - `label` / `progress` are truncated so one row cannot wrap into a wall on
 *     a phone; the whole row is capped at 400 chars for the same reason.
 *
 * Pure function: `now` is injectable so the age column is testable.
 */
export function renderBackgroundJobsSection(
  jobs: readonly BackgroundJobView[],
  now: number = Date.now(),
): string[] {
  if (jobs.length === 0) return [];
  const running = jobs
    .filter((job) => BACKGROUND_JOB_LIVE.has(job.status))
    // Oldest first: the job that has been running longest is the one the user
    // is most likely to have forgotten about.
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  const count = running.length > 0
    ? `🟢 共 ${jobs.length} 个 · 运行中 ${running.length} 个`
    : `⚪ 共 ${jobs.length} 个`;
  const out = ["[后台任务]", `  • ${count}`];

  for (const job of running.slice(0, BACKGROUND_JOB_DETAIL_MAX)) {
    const kind = job.kind.trim() || "job";
    const label = truncateForWeChat(job.label.trim() || job.id, 60);
    const age = job.startedAt === undefined ? "" : `（已运行 ${formatJobAge(now - job.startedAt)}）`;
    const progress = job.progress?.trim()
      ? ` · ${truncateForWeChat(job.progress.trim(), 40)}`
      : "";
    out.push(`    ▶ ${truncateForWeChat(`${kind} · ${label}`, 120)}${age}${progress}`.slice(0, 400));
  }

  const hidden = running.length - BACKGROUND_JOB_DETAIL_MAX;
  if (hidden > 0) out.push(`    … 另有 ${hidden} 个运行中`);
  return out;
}
