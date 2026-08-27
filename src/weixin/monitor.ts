/**
 * WeChat long-poll monitor loop.
 * Polls getUpdates, dispatches messages via callback.
 * Ported from wechat-opencode (MIT) — https://github.com/pan17/wechat-opencode
 */

import fs from "node:fs";
import path from "node:path";
import {
  getUpdates,
  notifyStart,
  isSessionTimeoutError,
} from "./api.js";
import type { WeixinMessage, GetUpdatesResp } from "./types.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;

// Recovery-flow constants. Modeled on Tencent/openclaw-weixin PR #161
// (https://github.com/Tencent/openclaw-weixin/pull/161): on errcode -14
// the monitor calls notifyStart to rebuild the server-side session, then
// either retries within seconds (success) or backs off exponentially up
// to a 5-minute ceiling (failure). The original 60-minute wall would loop
// indefinitely because getUpdates was retried without ever rebuilding the
// session.
const NOTIFY_START_TIMEOUT_MS = 10_000;
const RECOVERY_INITIAL_BACKOFF_MS = 5_000;
const RECOVERY_MAX_BACKOFF_MS = 5 * 60_000;
const RECOVERY_BACKOFF_GROWTH = 2;
const RECOVERY_RETRY_AFTER_SUCCESS_MS = 5_000;
// After this many consecutive notifyStart failures we surface a "consider
// re-scanning" hint. Anything below this is recoverable noise; anything
// above it is persistent enough that user action may help.
const RESCAN_HINT_AFTER_FAILURES = 6;

export interface MonitorOpts {
  baseUrl: string;
  token?: string;
  storageDir: string;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  log: (msg: string) => void;
  onMessage: (msg: WeixinMessage) => void;
  /** Gateway rejected the bot session (`-14`). Outbound should park. */
  onSessionInvalid?: () => void;
  /** A subsequent getUpdates succeeded; outbound may resume and flush. */
  onSessionRecovered?: () => void;
  /**
   * notifyStart failed enough times that the user should re-scan.
   * Fired once when the hint threshold is first crossed.
   */
  onSessionGiveUp?: () => void;
}

function getSyncBufPath(storageDir: string): string {
  return path.join(storageDir, "sync-buf.json");
}

function loadSyncBuf(storageDir: string): string {
  const p = getSyncBufPath(storageDir);
  if (!fs.existsSync(p)) return "";
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as { get_updates_buf?: string };
    return data.get_updates_buf ?? "";
  } catch {
    return "";
  }
}

function saveSyncBuf(storageDir: string, buf: string): void {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(getSyncBufPath(storageDir), JSON.stringify({ get_updates_buf: buf }), "utf-8");
}

/** Drop the long-poll cursor so a new bot session does not resume the old one. */
export function clearSyncBuf(storageDir: string): void {
  const p = getSyncBufPath(storageDir);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // best effort
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}

export async function startMonitor(opts: MonitorOpts): Promise<void> {
  const { baseUrl, token, storageDir, abortSignal, log, onMessage, onSessionInvalid, onSessionRecovered, onSessionGiveUp } = opts;

  let getUpdatesBuf = loadSyncBuf(storageDir);
  if (getUpdatesBuf) {
    log(`Resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log("No previous sync buf, starting fresh");
  }

  let nextTimeoutMs = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  // Recovery state — see file header. Reset to initial on any successful
  // poll OR a successful notifyStart; grows on consecutive notifyStart
  // failures up to RECOVERY_MAX_BACKOFF_MS.
  let recoveryBackoffMs = RECOVERY_INITIAL_BACKOFF_MS;
  let consecutiveNotifyStartFailures = 0;

  const resetRecoveryState = (): void => {
    recoveryBackoffMs = RECOVERY_INITIAL_BACKOFF_MS;
    consecutiveNotifyStartFailures = 0;
  };

  /**
   * Try to rebuild the server-side session via notifyStart. Returns true
   * on success, false on failure (or abort). The caller is responsible
   * for the subsequent backoff/retry logic; this only attempts the call.
   */
  const tryRecover = async (): Promise<boolean> => {
    log(
      `Session timeout suspected — calling notifyStart to rebuild the server-side session...`,
    );
    try {
      await notifyStart({
        baseUrl,
        token,
        timeoutMs: NOTIFY_START_TIMEOUT_MS,
        abortSignal,
      });
      log(`notifyStart succeeded; server session rebuilt.`);
      return true;
    } catch (e) {
      if (abortSignal?.aborted) return false;
      log(`notifyStart failed: ${String(e)}`);
      return false;
    }
  };

  /**
   * Apply the recovery outcome: reset state + short retry on success,
   * grow the backoff on failure (and surface a re-scan hint once the
   * threshold is crossed). All sleeps respect the abort signal.
   */
  const applyRecoveryOutcome = async (recovered: boolean): Promise<void> => {
    if (recovered) {
      resetRecoveryState();
      try {
        await sleep(RECOVERY_RETRY_AFTER_SUCCESS_MS, abortSignal);
      } catch {
        if (abortSignal?.aborted) return;
      }
      return;
    }

    consecutiveNotifyStartFailures++;
    const waitMs = recoveryBackoffMs;
    recoveryBackoffMs = Math.min(
      recoveryBackoffMs * RECOVERY_BACKOFF_GROWTH,
      RECOVERY_MAX_BACKOFF_MS,
    );

    if (consecutiveNotifyStartFailures >= RESCAN_HINT_AFTER_FAILURES) {
      log(
        `notifyStart has failed ${consecutiveNotifyStartFailures} consecutive times ` +
          `(current backoff ${waitMs / 1000}s, next ${recoveryBackoffMs / 1000}s). ` +
          `If this persists, please re-scan the QR code to get a fresh bot_token.`,
      );
      if (consecutiveNotifyStartFailures === RESCAN_HINT_AFTER_FAILURES) {
        onSessionGiveUp?.();
      }
    } else {
      log(
        `notifyStart failed; backing off ${waitMs / 1000}s before retrying ` +
          `(next attempt in up to ${recoveryBackoffMs / 1000}s).`,
      );
    }

    try {
      await sleep(waitMs, abortSignal);
    } catch {
      if (abortSignal?.aborted) return;
    }
  };

  while (!abortSignal?.aborted) {
    try {
      const resp: GetUpdatesResp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE ||
          resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          onSessionInvalid?.();
          const recovered = await tryRecover();
          if (abortSignal?.aborted) return;
          await applyRecoveryOutcome(recovered);
          continue;
        }

        consecutiveFailures++;
        log(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log(`${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;
      resetRecoveryState();
      onSessionRecovered?.();

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveSyncBuf(storageDir, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      for (const msg of resp.msgs ?? []) {
        onMessage(msg);
      }
    } catch (err) {
      if (abortSignal?.aborted) return;

      if (isSessionTimeoutError(err)) {
        // Parseable JSON `-14` now throws SessionTimeoutError from apiPost
        // (HTTP 200 + body). The iLink gateway can also return HTTP 200
        // with a malformed Content-Length so undici throws before we read
        // the JSON. Both mean the bot session is dead — disable outbound
        // and rebuild via notifyStart.
        onSessionInvalid?.();
        const recovered = await tryRecover();
        if (abortSignal?.aborted) return;
        await applyRecoveryOutcome(recovered);
        continue;
      }

      consecutiveFailures++;
      log(`getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`);

      try {
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log(`${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
      } catch {
        if (abortSignal?.aborted) return;
      }
    }
  }
}
