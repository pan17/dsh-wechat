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
  /** Agent preset id for newly created DSH sessions. */
  agentPreset?: string;
  /** WeChat single-message length limit (chars). */
  textChunkLimit: number;
  /** Soft timeout for question/permission cards (ms). */
  cardTimeoutMs: number;
}

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
    agentPreset: undefined,
    textChunkLimit: 4000,
    cardTimeoutMs: 30 * 60_000,
  };
}
