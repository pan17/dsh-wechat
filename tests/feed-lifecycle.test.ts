/**
 * DSH feed lifecycle (issue #2 supplementary):
 *   - session/event session-id extraction
 *   - WeChat logout / gateway restart must NOT stop Host answerers
 *   - plugin stop() abandons pending WeChat waiters
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
  isInvalidRequestError: () => false,
}));

vi.mock("../src/weixin/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/weixin/auth.js")>();
  return {
    ...actual,
    login: () => new Promise(() => {}),
  };
});

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";
import { sessionIdFrom } from "../src/index.js";

function makeBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-feed-"));
  const ctx = { get: () => undefined, on: () => () => {} };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  return new WeChatDSHBridge(ctx, cfg);
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

describe("interaction lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gateway restart (internal reconnect) does not stop Host answerers", async () => {
    const bridge = makeBridge();
    expect((bridge as unknown as { interactionStopped: boolean }).interactionStopped).toBe(false);
    await bridge.reconnect();
    expect((bridge as unknown as { interactionStopped: boolean }).interactionStopped).toBe(false);
    await bridge.stop();
  });

  it("plugin stop() abandons pending WeChat waiters", async () => {
    const bridge = makeBridge();
    const store = (bridge as unknown as { state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void } }).state;
    store.ensureUser("u1", "C:\\work");
    store.update("u1", { sessionId: "wx-1" });
    (bridge as unknown as { handleMuxFrame(f: unknown): void }).handleMuxFrame({
      type: "server-request",
      rpcId: "rpc-1",
      method: "approval/requested",
      payload: { type: "approval/requested", sessionId: "wx-1", approvalId: "a-1", toolName: "pwsh" },
    });
    expect((bridge as unknown as { pendingApprovals: Map<string, unknown[]> }).pendingApprovals.get("u1")?.length).toBe(1);
    await bridge.stop();
    expect((bridge as unknown as { interactionStopped: boolean }).interactionStopped).toBe(true);
    expect((bridge as unknown as { pendingApprovals: Map<string, unknown[]> }).pendingApprovals.get("u1") ?? []).toHaveLength(0);
  });
});
