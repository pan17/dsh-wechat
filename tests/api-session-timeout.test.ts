/**
 * Regression tests for issue #1 — iLink session-timeout (-14) response.
 *
 * The iLink gateway returns HTTP 200 with body
 *   {"errcode":-14,"errmsg":"session timeout"}
 * but ships a malformed Content-Length header alongside it. undici throws
 * `InvalidArgumentError: invalid content-length header` before the body is
 * readable, so the real reason is buried under "fetch failed: …". These
 * tests pin down the predicate we use to recover that signal:
 *
 *   1. `isSessionTimeoutContentLengthError` walks the cause chain and
 *      matches the undici error shape.
 *   2. `getUpdates` propagates the underlying error unchanged (no retry, no
 *      wrapping) so the monitor can detect it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getUpdates,
  sendMessage,
  isSessionTimeoutContentLengthError,
  isSessionTimeoutError,
  SessionTimeoutError,
} from "../src/weixin/api.js";

function makeUndiciContentLengthError(): Error {
  // Mirrors what undici's `InvalidArgumentError` looks like in Node 20/22:
  //   class InvalidArgumentError extends UndiciError {
  //     code = "UND_ERR_INVALID_ARG";
  //     name = "InvalidArgumentError";
  //   }
  // with message "invalid content-length header".
  const err = new Error("invalid content-length header");
  err.name = "InvalidArgumentError";
  (err as Error & { code?: string }).code = "UND_ERR_INVALID_ARG";
  return err;
}

describe("isSessionTimeoutContentLengthError", () => {
  it("matches undici InvalidArgumentError on content-length", () => {
    const err = makeUndiciContentLengthError();
    expect(isSessionTimeoutContentLengthError(err)).toBe(true);
  });

  it("matches even when the message uses different casing", () => {
    const err = new Error("Invalid Content-Length Header");
    err.name = "InvalidArgumentError";
    (err as Error & { code?: string }).code = "UND_ERR_INVALID_ARG";
    expect(isSessionTimeoutContentLengthError(err)).toBe(true);
  });

  it("walks the cause chain when fetch wraps the error", () => {
    const inner = makeUndiciContentLengthError();
    const wrapped = new Error("fetch failed");
    (wrapped as Error & { cause?: unknown }).cause = inner;
    expect(isSessionTimeoutContentLengthError(wrapped)).toBe(true);
  });

  it("does not match a generic fetch failure", () => {
    expect(isSessionTimeoutContentLengthError(new Error("fetch failed"))).toBe(false);
  });

  it("does not match an InvalidArgumentError about a different argument", () => {
    const err = new Error("invalid argument");
    err.name = "InvalidArgumentError";
    (err as Error & { code?: string }).code = "UND_ERR_INVALID_ARG";
    expect(isSessionTimeoutContentLengthError(err)).toBe(false);
  });

  it("does not match null, undefined, primitives, or non-objects", () => {
    expect(isSessionTimeoutContentLengthError(null)).toBe(false);
    expect(isSessionTimeoutContentLengthError(undefined)).toBe(false);
    expect(isSessionTimeoutContentLengthError("invalid content-length")).toBe(false);
    expect(isSessionTimeoutContentLengthError(42)).toBe(false);
  });

  it("does not loop forever on cyclic cause chains", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    a.cause = b;
    b.cause = a;
    // Not the matching error type — should return false, not hang.
    expect(isSessionTimeoutContentLengthError(a)).toBe(false);
  });
});

describe("getUpdates: session-timeout content-length propagation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects with the undici InvalidArgumentError (no retry, no wrap)", async () => {
    const err = makeUndiciContentLengthError();
    const fetchMock = vi.fn().mockRejectedValue(err);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      getUpdates({ baseUrl: "https://gw", token: "t", get_updates_buf: "" }),
    ).rejects.toMatchObject({
      name: "InvalidArgumentError",
      code: "UND_ERR_INVALID_ARG",
      message: expect.stringMatching(/content-length/i),
    });

    // getUpdates uses retries: 0 — a single fetch attempt, no busy loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendMessage: parseable -14 is a thrown SessionTimeoutError", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects HTTP 200 + errcode -14 instead of treating it as success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errcode: -14, errmsg: "session timeout" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      sendMessage({
        baseUrl: "https://gw",
        token: "t",
        body: { msg: { to_user_id: "u1" } },
        retries: 0,
      }),
    ).rejects.toBeInstanceOf(SessionTimeoutError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("isSessionTimeoutError matches both JSON and undici shapes", () => {
    expect(isSessionTimeoutError(new SessionTimeoutError())).toBe(true);
    const undici = new Error("invalid content-length header");
    undici.name = "InvalidArgumentError";
    (undici as Error & { code?: string }).code = "UND_ERR_INVALID_ARG";
    expect(isSessionTimeoutError(undici)).toBe(true);
    expect(isSessionTimeoutError(new Error("fetch failed"))).toBe(false);
  });
});
