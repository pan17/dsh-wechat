/**
 * DSH feed lifecycle (issue #2 supplementary):
 *   - session/event session-id extraction
 *   - attachMux is a single loop (HMR / double inject must not dual-open)
 *   - WeChat logout / gateway restart must NOT abort mux
 *   - plugin stop() does abort mux
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage: vi.fn().mockResolvedValue(undefined),
  sendMediaMessage: vi.fn().mockResolvedValue(undefined),
  splitText: (text: string) => [text],
}));

vi.mock("../src/weixin/api.js", () => ({
  sendTyping: () => Promise.resolve(undefined),
  getConfig: () => Promise.resolve({ typing_ticket: "tk" }),
  isSessionTimeoutError: () => false,
  isMessageLimitError: () => false,
}));

vi.mock("../src/weixin/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/weixin/auth.js")>();
  return {
    ...actual,
    login: () => new Promise(() => {}),
  };
});

import { WeChatDSHBridge, type ApiProxySurface } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";
import { sessionIdFrom } from "../src/index.js";

function makeBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-feed-"));
  const ctx = { get: () => undefined, on: () => () => {} };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  return new WeChatDSHBridge(ctx, cfg);
}

function hangingMux() {
  let calls = 0;
  const mux = vi.fn((_req: unknown, signal: AbortSignal) => {
    calls++;
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
  });
  return { mux, getCalls: () => calls };
}

describe("sessionIdFrom", () => {
  it("reads session.id", () => {
    expect(sessionIdFrom({ id: "s1" })).toBe("s1");
  });

  it("falls back to header.id and nested session", () => {
    expect(sessionIdFrom({ header: { id: "s2" } })).toBe("s2");
    expect(sessionIdFrom({ session: { header: { id: "s3" } } })).toBe("s3");
    expect(sessionIdFrom({ session: { id: "s4" } })).toBe("s4");
  });

  it("returns undefined when nothing matches", () => {
    expect(sessionIdFrom(undefined)).toBeUndefined();
    expect(sessionIdFrom({})).toBeUndefined();
    expect(sessionIdFrom({ id: "" })).toBeUndefined();
  });
});

describe("mux loop lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attachMux is idempotent — a second call does not open another stream", async () => {
    const bridge = makeBridge();
    const { mux, getCalls } = hangingMux();
    const api: ApiProxySurface = { respond: vi.fn() as never, events: { mux } };
    bridge.attachMux(api);
    bridge.attachMux(api);
    await Promise.resolve();
    expect(getCalls()).toBe(1);
    await bridge.stop();
  });

  it("gateway restart (internal reconnect) does not abort the mux stream", async () => {
    const bridge = makeBridge();
    const { mux, getCalls } = hangingMux();
    const api: ApiProxySurface = { respond: vi.fn() as never, events: { mux } };
    bridge.attachMux(api);
    await Promise.resolve();
    expect(getCalls()).toBe(1);

    await bridge.reconnect();
    await Promise.resolve();
    expect(getCalls()).toBe(1);
    expect((bridge as unknown as { muxStopped: boolean }).muxStopped).toBe(false);

    await bridge.stop();
  });

  it("plugin stop() aborts mux so the hanging iterator settles", async () => {
    const bridge = makeBridge();
    let settled = false;
    const mux = vi.fn((_req: unknown, signal: AbortSignal) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            settled = true;
            resolve();
          }, { once: true });
        });
      },
    }));
    const api: ApiProxySurface = { respond: vi.fn() as never, events: { mux } };
    bridge.attachMux(api);
    await Promise.resolve();
    await bridge.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
    expect((bridge as unknown as { muxStopped: boolean }).muxStopped).toBe(true);
  });
});
