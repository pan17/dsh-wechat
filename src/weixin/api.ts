/**
 * WeChat iLink HTTP API client.
 * Adapted from @tencent-weixin/openclaw-weixin api/api.ts and
 * wechat-opencode (MIT) — https://github.com/pan17/wechat-opencode
 */

import crypto from "node:crypto";

import type {
  BaseInfo,
  GetUpdatesResp,
  SendMessageReq,
  GetUploadUrlReq,
  GetUploadUrlResp,
  SendTypingReq,
  GetConfigResp,
} from "./types.js";
import { isRetryableNetworkError } from "../utils/network.js";

const CHANNEL_VERSION = "1.0.2";

export { isRetryableNetworkError };

export interface ApiPostOptions {
  /** How many retries to attempt on transient network failures. Default: 2. */
  retries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000 (so 1s, 2s, 4s, ...). */
  baseDelayMs?: number;
  /**
   * Optional external abort signal — when aborted, the current fetch
   * rejects immediately.
   */
  abortSignal?: AbortSignal;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(opts: { token?: string; body?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (opts.body) {
    headers["Content-Length"] = String(Buffer.byteLength(opts.body, "utf-8"));
  }
  if (opts.token?.trim()) {
    headers["Authorization"] = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

async function apiGet<T>(baseUrl: string, path: string, token?: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${path}`;
  const res = await fetch(url, { headers: buildHeaders({ token }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = 15_000,
  options?: ApiPostOptions,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const payload = { ...body, base_info: buildBaseInfo() };
  const bodyStr = JSON.stringify(payload);

  const retries = options?.retries ?? 2;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const maxAttempts = retries + 1;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let externalAbortListener: (() => void) | undefined;
    if (options?.abortSignal) {
      if (options.abortSignal.aborted) {
        controller.abort();
      } else {
        externalAbortListener = () => controller.abort();
        options.abortSignal.addEventListener("abort", externalAbortListener, { once: true });
      }
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: buildHeaders({ token, body: bodyStr }),
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return JSON.parse(text) as T;
    } catch (err) {
      clearTimeout(timer);
      // AbortError sentinel: getUpdates long-poll timed out, no messages.
      if ((err as Error).name === "AbortError") {
        return { ret: 0, msgs: [] } as T;
      }
      lastError = err;

      const isLastAttempt = attempt >= retries;
      if (isLastAttempt || !isRetryableNetworkError(err)) {
        break;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt);
      // eslint-disable-next-line no-console
      console.error(
        `apiPost ${endpoint} failed (attempt ${attempt + 1}/${maxAttempts}), ` +
          `retrying in ${delayMs}ms: ${String(err)}`,
      );
      await sleep(delayMs);
    } finally {
      if (externalAbortListener && options?.abortSignal) {
        options.abortSignal.removeEventListener("abort", externalAbortListener);
      }
    }
  }

  const cause = (lastError as Error & { cause?: unknown })?.cause;
  if (cause !== undefined) {
    const wrapped = new Error(`${(lastError as Error).message}: ${String(cause)}`);
    (wrapped as Error & { cause?: unknown }).cause = cause;
    throw wrapped;
  }
  throw lastError;
}

export async function getUpdates(params: {
  baseUrl: string;
  token?: string;
  get_updates_buf: string;
  timeoutMs?: number;
}): Promise<GetUpdatesResp> {
  // Long-poll: do NOT retry on transient network errors here — the
  // monitor loop already has its own retry/backoff.
  return apiPost<GetUpdatesResp>(
    params.baseUrl,
    "ilink/bot/getupdates",
    { get_updates_buf: params.get_updates_buf },
    params.token,
    params.timeoutMs ?? 38_000,
    { retries: 0 },
  );
}

export async function sendMessage(params: {
  baseUrl: string;
  token?: string;
  body: SendMessageReq;
  retries?: number;
}): Promise<void> {
  await apiPost(
    params.baseUrl,
    "ilink/bot/sendmessage",
    params.body as unknown as Record<string, unknown>,
    params.token,
    undefined,
    { retries: params.retries ?? 2 },
  );
}

export async function getUploadUrl(params: {
  baseUrl: string;
  token?: string;
  body: GetUploadUrlReq;
}): Promise<GetUploadUrlResp> {
  return apiPost<GetUploadUrlResp>(
    params.baseUrl,
    "ilink/bot/getuploadurl",
    params.body as unknown as Record<string, unknown>,
    params.token,
  );
}

export async function getConfig(params: {
  baseUrl: string;
  token?: string;
  ilinkUserId: string;
  contextToken?: string;
}): Promise<GetConfigResp> {
  return apiPost<GetConfigResp>(
    params.baseUrl,
    "ilink/bot/getconfig",
    {
      ilink_user_id: params.ilinkUserId,
      ...(params.contextToken ? { context_token: params.contextToken } : {}),
    },
    params.token,
    10_000,
  );
}

export async function sendTyping(params: {
  baseUrl: string;
  token?: string;
  body: SendTypingReq;
}): Promise<void> {
  await apiPost(
    params.baseUrl,
    "ilink/bot/sendtyping",
    params.body as unknown as Record<string, unknown>,
    params.token,
    10_000,
  );
}

export async function getBotQrcode(params: {
  baseUrl: string;
  botType?: string;
}): Promise<{ qrcode: string; qrcode_img_content: string }> {
  return apiGet(
    params.baseUrl,
    `ilink/bot/get_bot_qrcode?bot_type=${params.botType ?? "3"}`,
  );
}

export async function getQrcodeStatus(params: {
  baseUrl: string;
  qrcode: string;
}): Promise<{
  status: string;
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}> {
  return apiGet(
    params.baseUrl,
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`,
  );
}
