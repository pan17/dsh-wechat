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
  /** Cross-session notifications (turn/end + error + cards of non-current sessions). Default off. */
  crossSessionNotify: boolean;
  /** Inject the WeChat surface prompt while the last user message came from WeChat. Default off. */
  surfacePromptEnabled: boolean;
  /** Runtime-context text injected for WeChat-driven turns (edited from the settings page). */
  surfacePrompt: string;
}

/** Default WeChat surface prompt — injected as a runtime-context snapshot. */
export const DEFAULT_SURFACE_PROMPT =
  "你正在通过微信(WeChat)与用户聊天。回复会发送到微信，请使用适合微信阅读的格式（纯文本、适度使用 emoji、避免过长的表格）。";

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
    surfacePromptEnabled: false,
    surfacePrompt: DEFAULT_SURFACE_PROMPT,
  };
}
