/**
 * Configuration types and defaults for dsh-wechat.
 */

import path from "node:path";
import os from "node:os";

export interface WeChatDSHConfig {
  /** WeChat iLink gateway base URL. */
  baseUrl: string;
  /** WeChat CDN base URL (media upload/download). */
  cdnBaseUrl: string;
  /** iLink bot type. */
  botType: string;
  /** Storage directory (token, sync-buf, session mapping). */
  storageDir: string;
  /** Working directory for newly created DSH sessions. */
  cwd: string;
  /** WeChat single-message length limit (chars). */
  textChunkLimit: number;
  /** Soft timeout for question/permission cards (ms). */
  cardTimeoutMs: number;
  /** Cross-session decision push (full permission/question cards of non-current sessions). Default off. */
  crossSessionNotify: boolean;
  /**
   * Background-task completion/error notices for non-current sessions.
   * Independent of `crossSessionNotify` (which now only gates decision
   * cards); default off so only decision cards reach WeChat unless enabled.
   */
  notifyTaskEvents: boolean;
  /**
   * Silent mode: only send the final text of each turn. Global, survives
   * re-scan (which clears per-user `state.json`). Default off.
   */
  silent: boolean;
  /**
   * 结论模式 / Final-only: hold every narration push (the bound session's
   * assistant text AND cross-session task notices) and deliver exactly one
   * consolidated conclusion once the whole task has gone quiet. Where
   * `silent` is per-TURN (one message per turn — a goal that auto-continues
   * over 8 rounds still produces 8 messages), `finalOnly` is per-TASK.
   * Takes precedence over `silent`. Default off.
   */
  finalOnly: boolean;
  /** `finalOnly` settle window (ms): every activity event pushes it back. */
  finalOnlyIdleMs: number;
  /** `finalOnly` hard ceiling (ms): after this, deliver whatever is held. */
  finalOnlyCeilingMs: number;
  /** Inject the WeChat surface prompt while the last user message came from WeChat. Default off. */
  surfacePromptEnabled: boolean;
  /** Runtime-context text injected for WeChat-driven turns (edited from the settings page). */
  surfacePrompt: string;
  /**
   * Per-minute cap on agent-initiated `send_wechat` pushes. `0` disables the
   * cap. A runaway agent loop can otherwise spend the whole 10-message
   * gateway window on narration and leave no room for the answer; at the cap
   * the tool returns `ok:false` so the model stops pushing instead of the
   * bridge silently dropping what it sent.
   */
  sendWechatRateLimitPerMinute: number;
  /**
   * Inbound allowlist of WeChat user ids. EMPTY (the default) keeps the
   * historical single-peer behaviour: the first inbound user becomes the
   * bound peer. Non-empty means only those ids are processed — anyone else
   * is ignored with a log line, never answered.
   *
   * On upgrade the bridge SEEDS this list from the already bound peer when it
   * is still empty (see `WeChatDSHBridge.seedAllowlistFromPeer`): before that,
   * an install which had already been claimed by one user would hand ownership
   * to whoever messaged first after the upgrade. A brand-new install (no bound
   * peer yet) keeps first-contact-wins.
   */
  allowedUsers: string[];
  /**
   * Allow `/perm default <preset>` from WeChat to raise the GLOBAL, persistent
   * permission default (`permission.defaultPreset`, which applies to every
   * future session of this DSH install, WeChat-related or not).
   *
   * Default `false`: a chat message may only write a default that does not
   * escalate — a preset whose resolved sandbox is `danger-full-access` or
   * whose approval policy is `never` is refused with a pointer to the DSH
   * settings page. Session-scoped `/perm switch` is unaffected (it is not
   * persistent), and set this to `true` to restore the pre-guard behaviour.
   */
  allowRemotePermissionEscalation: boolean;
  /**
   * Allow `send_wechat` to read ANY absolute path on the host.
   *
   * Default `false`, which confines the tool to files inside the CALLING
   * session's working directory or a registered workspace: without a bound,
   * the tool is an arbitrary-file-read primitive for any agent (and for
   * anything that can talk an agent into calling it). Set to `true` to
   * restore the pre-bound behaviour.
   */
  allowAnyFilePath: boolean;
  /**
   * Hard size ceiling for a file handed to `send_wechat` (bytes). A larger
   * file is refused before it is read or queued, so an agent cannot turn the
   * bridge into a memory/spool amplifier. Default 20 MiB.
   */
  maxOutgoingFileBytes: number;
  /**
   * Inbound merge window (打字合并): consecutive WeChat text messages from the
   * peer are buffered per chat and delivered as ONE prompt instead of one turn
   * per message, so a thought typed as five bubbles costs one turn.
   *
   * Default `false` — every WeChat message is its own turn unless the operator
   * opts in (from WeChat with `/merge on`, or in the settings page). Batching
   * changes what "one turn" MEANS — a turn can then carry several user messages
   * — and it adds a few seconds of latency per message, which is the wrong
   * trade for the short imperative commands that dominate this channel. Opt-in
   * keeps the pre-0.12 one-message-one-turn behaviour on upgrade.
   */
  mergeEnabled: boolean;
  /** Silence window (ms) after the last buffered message before the batch is delivered. `0` disables the window. */
  mergeSilenceMs: number;
  /** Hard cap on buffered messages per batch — a defensive bound, never exceeded. */
  mergeMaxMsgs: number;
  /**
   * Suffix tokens inside the message text: a trailing `..` keeps the batch
   * open (no silence flush), a trailing `!!` commits it immediately. Both are
   * STRIPPED from the text when the feature is on.
   */
  mergeSuffixTokens: boolean;
  /**
   * Forced release (ms): the hard ceiling that delivers a batch regardless of
   * the silence window, a `..` hold, or a still-in-flight previous batch —
   * "rather two messages in one turn than a permanently blocked channel".
   * Default 3 minutes.
   */
  mergeForcedReleaseMs: number;
  /**
   * 图片/文件与文字合并发送 (media + text coalescing).
   *
   * Historically a media item NEVER joined a text batch: it flushed the
   * pending text as its own turn and then went to the agent as a SECOND turn,
   * so "here is my screenshot, please look at it" required two turns and the
   * agent answered the image before it had the question.
   *
   * With this switch on, a media message that carries NO text of its own is
   * HELD (nothing is downloaded yet) and delivered together with the text the
   * user types next, as ONE prompt. A media message that already carries its
   * own caption still goes straight through: it needs no follow-up sentence.
   *
   * Default `false`: an untouched install keeps the 0.12 behaviour exactly
   * (media is never delayed), because holding an image for a sentence that
   * never arrives would look like a dropped message.
   */
  mediaMergeEnabled: boolean;
  /**
   * How long a held media item waits for its text (ms). When the window
   * elapses the held items are delivered on their own — a picture with no
   * question still deserves an answer, and "held forever" is not a state a
   * chat channel may reach. The effective wait is
   * `min(mediaHoldMs, mergeForcedReleaseMs)`, so the merge window's own
   * liveness ceiling also bounds this one.
   *
   * Default 3 minutes — the same as `mergeForcedReleaseMs`, i.e. by default the
   * attachment wait IS the merge window's liveness ceiling, the longest a turn
   * may be held at all.
   */
  mediaHoldMs: number;
  /**
   * How inbound media is handed to the model:
   *
   *   - `false` (default) — the historical text: the file is announced with
   *     its saved absolute path ("文件已保存到: …"), and text files also have
   *     their content inlined.
   *   - `true` — the file is announced as a host `@文件` reference
   *     (`@path` / `@"path with spaces"`), the exact token the GUI composer
   *     produces. `@deepseek-ai/dsh-file-reference-local` then tells the model
   *     to call `read` instead of pretending it inspected the file, and no
   *     file content is inlined.
   *
   * Either way the bytes still land on disk: a reference is a pointer, not a
   * replacement for the saved file.
   */
  mediaAtRefEnabled: boolean;
}

/** Default WeChat surface prompt — injected as a runtime-context snapshot. */
export const DEFAULT_SURFACE_PROMPT =
  "你正在通过微信(WeChat)与用户聊天。回复会发送到微信，请使用适合微信阅读的格式（支持简单的 Markdown、适度使用 emoji、避免过长的表格）。";

/**
 * Superseded built-in prompts. `surfacePrompt` is persisted verbatim once the
 * settings page is saved, so a stored value equal to one of these is an
 * untouched default rather than a user customization: it is dropped on load so
 * the current {@link DEFAULT_SURFACE_PROMPT} applies. Genuinely edited prompts
 * never match and are always preserved.
 */
export const LEGACY_SURFACE_PROMPTS: readonly string[] = [
  "你正在通过微信(WeChat)与用户聊天。回复会发送到微信，请使用适合微信阅读的格式（纯文本、适度使用 emoji、避免过长的表格）。",
];

export function defaultStorageDir(): string {
  return path.join(os.homedir(), ".dsh-wechat");
}

export function defaultConfig(): WeChatDSHConfig {
  return {
    baseUrl: "https://ilinkai.weixin.qq.com",
    cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
    botType: "3",
    storageDir: defaultStorageDir(),
    cwd: process.cwd(),
    textChunkLimit: 4000,
    cardTimeoutMs: 30 * 60_000,
    crossSessionNotify: false,
    notifyTaskEvents: false,
    silent: false,
    finalOnly: false,
    finalOnlyIdleMs: 45_000,
    finalOnlyCeilingMs: 10 * 60_000,
    surfacePromptEnabled: false,
    surfacePrompt: DEFAULT_SURFACE_PROMPT,
    sendWechatRateLimitPerMinute: 10,
    allowedUsers: [],
    allowRemotePermissionEscalation: false,
    allowAnyFilePath: false,
    maxOutgoingFileBytes: 20 * 1024 * 1024,
    mergeEnabled: false,
    mergeSilenceMs: 3000,
    mergeMaxMsgs: 10,
    mergeSuffixTokens: true,
    mergeForcedReleaseMs: 3 * 60_000,
    mediaMergeEnabled: false,
    mediaHoldMs: 3 * 60_000,
    mediaAtRefEnabled: false,
  };
}
