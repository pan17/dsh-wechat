/**
 * Regression tests for issue #1 — monitor must recover from iLink
 * session-timeout (errcode -14) without entering the 60-minute death loop
 * the original implementation suffered.
 *
 * The fix follows Tencent/openclaw-weixin PR #161: instead of pausing for
 * 60 minutes on -14 and then immediately hitting -14 again on retry, the
 * monitor calls `notifyStart` to rebuild the server-side session. On
 * success it retries `getUpdates` within seconds; on failure it backs off
 * exponentially up to a 5-minute ceiling. The user-facing "re-scan QR"
 * hint only fires after multiple consecutive `notifyStart` failures —
 * i.e. when the recovery path itself looks persistently broken.
 *
 * Two `-14` shapes are covered: the parseable JSON body
 * `{"errcode":-14,...}` AND undici's `InvalidArgumentError: invalid
 * content-length header` (the actual surface dsh-wechat issue #1 reports).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startMonitor } from "../src/weixin/monitor.js";

function makeUndiciContentLengthError(): Error {
  const err = new Error("invalid content-length header");
  err.name = "InvalidArgumentError";
  (err as Error & { code?: string }).code = "UND_ERR_INVALID_ARG";
  return err;
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Long-poll simulator. The "happy" getUpdates response should block until
 * either the abort signal fires or a short delay elapses — mirroring the
 * real iLink behavior. Without this the monitor's loop spins on
 * instantly-resolving mocks and OOMs the test worker.
 */
function longPoll(delayMs: number, abortSignal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => resolve(okJson({ ret: 0, msgs: [] })), delayMs);
    abortSignal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

interface DispatcherHandle {
  fetch: ReturnType<typeof vi.fn>;
  counts: { getupdates: number; notifystart: number; notifystop: number; other: number };
}

function makeDispatcher(
  handler: (
    path: "getupdates" | "notifystart" | "notifystop" | "other",
    init: RequestInit | undefined,
    abortSignal: AbortSignal | undefined,
  ) => Promise<Response>,
): DispatcherHandle {
  const counts = { getupdates: 0, notifystart: 0, notifystop: 0, other: 0 };
  const fetchMock = vi
    .fn()
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      let path: keyof typeof counts = "other";
      if (url.includes("/getupdates")) path = "getupdates";
      else if (url.includes("/msg/notifystart")) path = "notifystart";
      else if (url.includes("/msg/notifystop")) path = "notifystop";
      counts[path]++;
      return handler(path, init, init?.signal ?? undefined);
    });
  return { fetch: fetchMock, counts };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("startMonitor: errcode -14 recovery (PR #161 contract)", () => {
  const originalFetch = globalThis.fetch;
  let dispatch: DispatcherHandle;
  let logMessages: string[];

  beforeEach(() => {
    logMessages = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("triggers notifyStart BEFORE any long pause when -14 comes back as a parseable body", async () => {
    let getupdatesCount = 0;
    dispatch = makeDispatcher(async (path, _init, abortSignal) => {
      if (path === "getupdates") {
        getupdatesCount++;
        if (getupdatesCount === 1) return okJson({ errcode: -14, errmsg: "session timeout" });
        return longPoll(500, abortSignal);
      }
      if (path === "notifystart") return okJson({ ret: 0 });
      throw new Error(`unexpected fetch path: ${path}`);
    });
    globalThis.fetch = dispatch.fetch as unknown as typeof fetch;

    const abort = new AbortController();
    const invalid = vi.fn();
    const recovered = vi.fn();
    const monitorPromise = startMonitor({
      baseUrl: "https://gw",
      token: "t",
      storageDir: "/tmp",
      abortSignal: abort.signal,
      log: (m) => logMessages.push(m),
      onMessage: () => {},
      onSessionInvalid: invalid,
      onSessionRecovered: recovered,
    });

    // Cycle 1: getUpdates → -14 → notifyStart → success → 5s retry sleep.
    // We abort before the retry sleep finishes so the test stays fast.
    await sleep(200);
    abort.abort();
    await monitorPromise;

    // notifyStart was attempted (the recovery contract).
    expect(dispatch.counts.notifystart).toBe(1);
    // The old 60-minute pause is gone.
    const joined = logMessages.join("\n");
    expect(joined).not.toMatch(/pausing 1 hour/i);
    expect(joined).not.toMatch(/3600/);
    // The recovery hint is explicit.
    expect(joined).toMatch(/notifyStart/i);
    expect(joined).toMatch(/rebuild the server-side session/i);
    expect(invalid).toHaveBeenCalled();
  });

  it("InvalidArgumentError(content-length) takes the SAME recovery path as parseable -14", async () => {
    dispatch = makeDispatcher(async (path, _init, abortSignal) => {
      if (path === "getupdates") throw makeUndiciContentLengthError();
      if (path === "notifystart") return okJson({ ret: 0 });
      if (path === "notifystop") return okJson({ ret: 0 });
      throw new Error(`unexpected fetch path: ${path}`);
    });
    globalThis.fetch = dispatch.fetch as unknown as typeof fetch;

    const abort = new AbortController();
    const monitorPromise = startMonitor({
      baseUrl: "https://gw",
      token: "t",
      storageDir: "/tmp",
      abortSignal: abort.signal,
      log: (m) => logMessages.push(m),
      onMessage: () => {},
    });

    await sleep(200);
    abort.abort();
    await monitorPromise;

    expect(dispatch.counts.notifystart).toBe(1);
    const joined = logMessages.join("\n");
    expect(joined).toMatch(/Session timeout suspected/i);
    expect(joined).toMatch(/notifyStart succeeded/i);
  });

  it("successful notifyStart → recovery state reset → getUpdates resumes (no re-scan hint)", async () => {
    let getupdatesCount = 0;
    dispatch = makeDispatcher(async (path, _init, abortSignal) => {
      if (path === "getupdates") {
        getupdatesCount++;
        if (getupdatesCount === 1) return okJson({ errcode: -14, errmsg: "session timeout" });
        return longPoll(500, abortSignal);
      }
      if (path === "notifystart") return okJson({ ret: 0 });
      throw new Error(`unexpected fetch path: ${path}`);
    });
    globalThis.fetch = dispatch.fetch as unknown as typeof fetch;

    const abort = new AbortController();
    const monitorPromise = startMonitor({
      baseUrl: "https://gw",
      token: "t",
      storageDir: "/tmp",
      abortSignal: abort.signal,
      log: (m) => logMessages.push(m),
      onMessage: () => {},
    });

    // 5s retry-after-success + a partial long-poll. Abort well inside the
    // second poll so we observe the recovery without sitting on it.
    await sleep(5_500);
    abort.abort();
    await monitorPromise;

    expect(dispatch.counts.getupdates).toBeGreaterThanOrEqual(2);
    expect(dispatch.counts.notifystart).toBe(1);

    const joined = logMessages.join("\n");
    expect(joined).not.toMatch(/re-scan/i);
    expect(joined).not.toMatch(/consecutive failures/i);
  }, 15_000);

  it("notifyStart failure → exponential backoff well under the original 60-minute ceiling", async () => {
    dispatch = makeDispatcher(async (path) => {
      if (path === "getupdates") throw makeUndiciContentLengthError();
      if (path === "notifystart") throw new Error("HTTP 500: server down");
      throw new Error(`unexpected fetch path: ${path}`);
    });
    globalThis.fetch = dispatch.fetch as unknown as typeof fetch;

    const abort = new AbortController();
    const monitorPromise = startMonitor({
      baseUrl: "https://gw",
      token: "t",
      storageDir: "/tmp",
      abortSignal: abort.signal,
      log: (m) => logMessages.push(m),
      onMessage: () => {},
    });

    await sleep(200);
    abort.abort();
    await monitorPromise;

    const joined = logMessages.join("\n");
    // First failure backoff: 5s (initial). The next would be 10s, capped at
    // 5 minutes — never 60.
    expect(joined).toMatch(/backing off \d+s/i);
    expect(joined).not.toMatch(/backing off 3600s/i);
    expect(joined).not.toMatch(/pausing 1 hour/i);
    expect(joined).not.toMatch(/3600/);
    expect(joined).toMatch(/next attempt in up to 10s/i);
  });

  it("normal traffic: notifyStart is never called", async () => {
    dispatch = makeDispatcher(async (path, _init, abortSignal) => {
      if (path === "getupdates") return longPoll(200, abortSignal);
      throw new Error(`unexpected fetch path during normal traffic: ${path}`);
    });
    globalThis.fetch = dispatch.fetch as unknown as typeof fetch;

    const abort = new AbortController();
    const recovered = vi.fn();
    const invalid = vi.fn();
    const monitorPromise = startMonitor({
      baseUrl: "https://gw",
      token: "t",
      storageDir: "/tmp",
      abortSignal: abort.signal,
      log: (m) => logMessages.push(m),
      onMessage: () => {},
      onSessionRecovered: recovered,
      onSessionInvalid: invalid,
    });

    await sleep(500);
    abort.abort();
    await monitorPromise;

    expect(invalid).not.toHaveBeenCalled();
    expect(recovered).toHaveBeenCalled();
    expect(dispatch.counts.notifystart).toBe(0);
    expect(dispatch.counts.notifystop).toBe(0);
    expect(dispatch.counts.getupdates).toBeGreaterThanOrEqual(1);
  });

  it("recovery after a prior recovery: second -14 still recovers (no half-open state)", async () => {
    let getupdatesCount = 0;
    dispatch = makeDispatcher(async (path, _init, abortSignal) => {
      if (path === "getupdates") {
        getupdatesCount++;
        // -14 on calls 1 and 3, success (long-poll) on 2 and 4.
        if (getupdatesCount === 1 || getupdatesCount === 3) {
          return okJson({ errcode: -14, errmsg: "session timeout" });
        }
        return longPoll(500, abortSignal);
      }
      if (path === "notifystart") return okJson({ ret: 0 });
      throw new Error(`unexpected fetch path: ${path}`);
    });
    globalThis.fetch = dispatch.fetch as unknown as typeof fetch;

    const abort = new AbortController();
    const monitorPromise = startMonitor({
      baseUrl: "https://gw",
      token: "t",
      storageDir: "/tmp",
      abortSignal: abort.signal,
      log: (m) => logMessages.push(m),
      onMessage: () => {},
    });

    // Two recovery cycles: each is roughly (getUpdates -14 + notifyStart +
    // 5s sleep + getUpdates long-poll). Allow ~11s real time, then abort.
    await sleep(11_000);
    abort.abort();
    await monitorPromise;

    expect(dispatch.counts.notifystart).toBeGreaterThanOrEqual(2);
    expect(dispatch.counts.getupdates).toBeGreaterThanOrEqual(3);

    const joined = logMessages.join("\n");
    expect(joined).not.toMatch(/re-scan/i);
    expect((joined.match(/notifyStart succeeded/g) ?? []).length).toBeGreaterThanOrEqual(2);
  }, 20_000);
});

describe("startMonitor: re-scan hint threshold (fake timers)", () => {
  // Cover the persistent-failure UX branch with fake timers so the
  // exponential backoffs complete in microseconds rather than minutes.
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("after 6 consecutive notifyStart failures, the re-scan hint appears", async () => {
    vi.useFakeTimers();
    const logMessages: string[] = [];
    const dispatch = makeDispatcher(async (path) => {
      if (path === "getupdates") throw makeUndiciContentLengthError();
      if (path === "notifystart") throw new Error("HTTP 503: server down");
      throw new Error(`unexpected fetch path: ${path}`);
    });
    globalThis.fetch = dispatch.fetch as unknown as typeof fetch;

    const abort = new AbortController();
    const giveUp = vi.fn();
    const monitorPromise = startMonitor({
      baseUrl: "https://gw",
      token: "t",
      storageDir: "/tmp",
      abortSignal: abort.signal,
      log: (m) => logMessages.push(m),
      onMessage: () => {},
      onSessionGiveUp: giveUp,
    });

    // Advance enough fake time to clear every backoff between cycles.
    // 6 cycles of 5, 10, 20, 40, 80, 160 seconds = 315s — round up.
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    abort.abort();
    await monitorPromise;

    expect(dispatch.counts.notifystart).toBeGreaterThanOrEqual(6);

    const joined = logMessages.join("\n");
    expect(joined).toMatch(/re-scan/i);
    expect(joined).toMatch(/fresh bot_token/i);
    expect(giveUp).toHaveBeenCalledTimes(1);
  });
});
