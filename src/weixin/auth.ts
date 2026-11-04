/**
 * WeChat QR login flow + token persistence.
 * Ported from wechat-opencode (MIT) — https://github.com/pan17/wechat-opencode
 */

import fs from "node:fs";
import path from "node:path";
import { getBotQrcode, getQrcodeStatus } from "./api.js";
import { ensurePrivateDir, writePrivateFile } from "../utils/secure-fs.js";

export interface TokenData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
  savedAt: string;
}

function getAuthDir(storageDir: string): string {
  return path.join(storageDir, "auth");
}

function getTokenPath(storageDir: string): string {
  return path.join(getAuthDir(storageDir), "token.json");
}

/** Login was cancelled on purpose (dispose / logout / a new flow). */
export class LoginCancelledError extends Error {
  readonly code = "LOGIN_CANCELLED";
  constructor() {
    super("login cancelled");
    this.name = "LoginCancelledError";
  }
}

/**
 * One poll interval, cut short by `signal`. The timer is `unref`'d: a poll
 * cadence is never a reason to keep a shutting-down process alive.
 */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LoginCancelledError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LoginCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function loadToken(storageDir: string): TokenData | null {
  const tokenPath = getTokenPath(storageDir);
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath, "utf-8")) as TokenData;
  } catch {
    return null;
  }
}

export function saveToken(storageDir: string, data: TokenData): void {
  const authDir = getAuthDir(storageDir);
  ensurePrivateDir(authDir);
  const tokenPath = getTokenPath(storageDir);
  // 0o600 (dir 0o700): this file IS the bot credential — anyone who can read
  // it can send messages as the bot. On Windows Node ignores the mode and the
  // inherited `%USERPROFILE%` ACLs apply (see src/utils/secure-fs.ts).
  writePrivateFile(tokenPath, JSON.stringify(data, null, 2));
}

export async function login(params: {
  baseUrl: string;
  botType?: string;
  storageDir: string;
  log: (msg: string) => void;
  renderQrUrl?: (url: string) => void;
  /**
   * Cancels the scan poll (plugin dispose, logout, a superseded re-login).
   * The loop runs for up to 5 minutes, so it must be cancellable: without it
   * the plugin keeps a ref'd timer and an open socket per round long after the
   * host has been told teardown finished, and the process never drains.
   */
  abortSignal?: AbortSignal;
}): Promise<TokenData> {
  const { baseUrl, botType, storageDir, log, renderQrUrl, abortSignal } = params;

  log("Starting WeChat QR login...");

  const qrResp = await getBotQrcode({ baseUrl, botType, abortSignal });
  const qrcodeUrl = qrResp.qrcode_img_content;

  log("Please scan the QR code with WeChat:");
  if (renderQrUrl) {
    renderQrUrl(qrcodeUrl);
  } else {
    log(`QR URL: ${qrcodeUrl}`);
  }

  const deadline = Date.now() + 5 * 60_000;
  let currentQrcode = qrResp.qrcode;
  let refreshCount = 0;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) throw new LoginCancelledError();
    const statusResp = await getQrcodeStatus({ baseUrl, qrcode: currentQrcode, abortSignal });

    switch (statusResp.status) {
      case "wait":
        break;
      case "scaned":
        log("QR scanned, please confirm in WeChat...");
        break;
      case "expired": {
        refreshCount++;
        if (refreshCount > 3) {
          throw new Error("QR code expired multiple times, please retry");
        }
        log(`QR expired, refreshing (${refreshCount}/3)...`);
        const newQr = await getBotQrcode({ baseUrl, botType, abortSignal });
        currentQrcode = newQr.qrcode;
        if (renderQrUrl) {
          renderQrUrl(newQr.qrcode_img_content);
        } else {
          log(`New QR URL: ${newQr.qrcode_img_content}`);
        }
        break;
      }
      case "confirmed": {
        log("Login successful!");
        const tokenData: TokenData = {
          token: statusResp.bot_token!,
          baseUrl: statusResp.baseurl || baseUrl,
          accountId: statusResp.ilink_bot_id!,
          userId: statusResp.ilink_user_id!,
          savedAt: new Date().toISOString(),
        };
        saveToken(storageDir, tokenData);
        log(`Bot ID: ${tokenData.accountId}`);
        log(`Token saved to ${getTokenPath(storageDir)}`);
        return tokenData;
      }
    }

    await sleepUnlessAborted(1500, abortSignal);
  }

  throw new Error("Login timeout (5 minutes)");
}
