/**
 * `send_wechat` tool — recipient resolution:
 *
 *   - bound session sends to the bound user (existing behavior)
 *   - unbound session falls back to the first known WeChat user
 *     (single-user deployments are the norm)
 *   - no known users at all → returns a clear error
 *   - WeChat not logged in → returns "WeChat is not logged in"
 *   - fallback user has no context token → returns "user has not messaged yet"
 *   - empty / unknown agentId → falls back gracefully (no throw)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendMediaMessage = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
  sendMediaMessage: (...args: unknown[]) => sendMediaMessage(...args),
  splitText: (text: string, maxLen: number) =>
    text.length <= maxLen ? [text] : [text.slice(0, maxLen), text.slice(maxLen)],
}));

vi.mock("../src/weixin/api.js", () => ({
  sendTyping: () => Promise.resolve(undefined),
  getConfig: () => Promise.resolve({ typing_ticket: "tk-default" }),
}));

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { UploadMediaType } from "../src/weixin/types.js";
import { defaultConfig } from "../src/config.js";

function makeBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-send-"));
  const agentsService = {
    create: async () => undefined,
    resume: async () => undefined,
    get: () => undefined,
    list: () => [],
  };
  const ctx = {
    get: (name: string) => (name === "agents" ? agentsService : undefined),
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  return bridge as unknown as {
    token?: { baseUrl: string; token: string; accountId: string; userId: string; savedAt: string };
    contextTokens: Map<string, string>;
    state: {
      ensureUser(u: string, c: string): { userId: string; cwd: string; sessionId: string; silent: boolean };
      update(u: string, p: Partial<{ sessionId: string; silent: boolean; cwd: string; cwdExplicit?: boolean }>): void;
      all(): Array<{ userId: string; cwd: string; sessionId: string; silent: boolean }>;
    };
    handleSendWeChat(
      agentId: string,
      args: { text?: string; file_path?: string },
    ): Promise<{ ok: boolean; message: string }>;
  };
}

function setLoggedIn(bridge: ReturnType<typeof makeBridge>, accountId = "b1") {
  bridge.token = {
    baseUrl: "https://gw",
    token: "t",
    accountId,
    userId: "bot",
    savedAt: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

describe("send_wechat: bound session", () => {
  it("sends text to the user bound to the calling session", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.state.ensureUser("u1", "C:\\work");
    bridge.state.update("u1", { sessionId: "wx-s1" });
    bridge.contextTokens.set("u1", "ctx-1");

    const result = await bridge.handleSendWeChat("wx-s1", { text: "hello" });
    expect(result).toEqual({ ok: true, message: "sent 1 message(s)" });
    expect(sendTextMessage).toHaveBeenCalledWith("u1", "hello", expect.objectContaining({ contextToken: "ctx-1" }));
    expect(sendMediaMessage).not.toHaveBeenCalled();
  });

  it("sends a file via sendMediaMessage when file_path is provided", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.state.ensureUser("u1", "C:\\work");
    bridge.state.update("u1", { sessionId: "wx-s1" });
    bridge.contextTokens.set("u1", "ctx-1");

    const tmpFile = path.join(os.tmpdir(), `send-wechat-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "payload");

    try {
      const result = await bridge.handleSendWeChat("wx-s1", { file_path: tmpFile });
      expect(result.ok).toBe(true);
      expect(sendMediaMessage).toHaveBeenCalledTimes(1);
      const [, , , opts] = sendMediaMessage.mock.calls[0]! as [string, number, Buffer, { contextToken: string; fileName: string }];
      expect(opts.contextToken).toBe("ctx-1");
      expect(opts.fileName).toContain(".txt");
      expect(sendTextMessage).not.toHaveBeenCalled();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe("send_wechat: unbound session falls back to first known user", () => {
  it("unbound session + one user → sends to that user", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.state.ensureUser("u1", "C:\\work");
    // Note: u1 has no `sessionId` binding — but in normal operation the
    // ensureUser call also seeds sessionId: "". We set it explicitly to ""
    // and verify the tool still resolves to u1.
    bridge.state.update("u1", { sessionId: "" });
    bridge.contextTokens.set("u1", "ctx-1");

    // Calling from an entirely different (GUI) session — never bound.
    const result = await bridge.handleSendWeChat("gui-session-xyz", { text: "ping" });
    expect(result).toEqual({ ok: true, message: "sent 1 message(s)" });
    expect(sendTextMessage).toHaveBeenCalledWith("u1", "ping", expect.objectContaining({ contextToken: "ctx-1" }));
  });

  it("unbound session + multiple users → sends to the first known user", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    // Insert in a specific order; state.all() preserves insertion order.
    bridge.state.ensureUser("u1", "C:\\work");
    bridge.state.update("u1", { sessionId: "wx-s1" });
    bridge.state.ensureUser("u2", "C:\\work");
    bridge.state.update("u2", { sessionId: "wx-s2" });
    bridge.contextTokens.set("u1", "ctx-1");
    bridge.contextTokens.set("u2", "ctx-2");

    // Calling from a session bound to NOTHING → fallback should pick u1.
    const result = await bridge.handleSendWeChat("gui-session-xyz", { text: "ping" });
    expect(result.ok).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledWith("u1", "ping", expect.objectContaining({ contextToken: "ctx-1" }));
  });

  it("empty agentId falls back gracefully (no throw)", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.state.ensureUser("u1", "C:\\work");
    bridge.contextTokens.set("u1", "ctx-1");

    const result = await bridge.handleSendWeChat("", { text: "hi" });
    expect(result.ok).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledWith("u1", "hi", expect.objectContaining({ contextToken: "ctx-1" }));
  });
});

describe("send_wechat: no known users", () => {
  it("returns a clear error when no user has ever interacted", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    // No ensureUser call → state.all() is empty.

    const result = await bridge.handleSendWeChat("gui-session-xyz", { text: "hi" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no WeChat user has interacted yet/i);
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(sendMediaMessage).not.toHaveBeenCalled();
  });
});

describe("send_wechat: error paths (regression)", () => {
  it("returns 'WeChat is not logged in' when token is missing", async () => {
    const bridge = makeBridge();
    // No setLoggedIn — token stays undefined.
    bridge.state.ensureUser("u1", "C:\\work");
    bridge.contextTokens.set("u1", "ctx-1");

    const result = await bridge.handleSendWeChat("wx-s1", { text: "hi" });
    expect(result).toEqual({ ok: false, message: "WeChat is not logged in" });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("returns 'user has not messaged yet' when fallback user has no context token", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.state.ensureUser("u1", "C:\\work");
    // No contextTokens.set — token is missing for the fallback user.

    const result = await bridge.handleSendWeChat("gui-session-xyz", { text: "hi" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/user has not messaged yet/i);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("returns an error when neither text nor file_path is provided", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.state.ensureUser("u1", "C:\\work");
    bridge.contextTokens.set("u1", "ctx-1");

    const result = await bridge.handleSendWeChat("wx-s1", {});
    expect(result).toEqual({ ok: false, message: "provide either text or file_path" });
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(sendMediaMessage).not.toHaveBeenCalled();
  });
});

// ─── Shared gateway budget & cache recovery ───
//
// `send_wechat` deliveries flow through the same deliverOutbound path as
// assistant replies: they consume the per-user message budget
// (`wechatMsgCount`), and items beyond the limit (or transiently failed)
// are parked in `outboundCache` for /next or auto-flush delivery instead
// of being lost. The 💾 cache notice rides a direct send outside the
// budget, so "queued" cases still show exactly one sendTextMessage call.

describe("send_wechat: shared gateway budget & cache", () => {
  interface BudgetBridge {
    wechatMsgCount: Map<string, number>;
    outboundCache: Map<string, Array<{ kind: string; text?: string; filePath?: string; fileName?: string }>>;
    sendReply(userId: string, text: string): Promise<void>;
    flushPending(userId: string): Promise<void>;
  }
  const asBudget = (bridge: ReturnType<typeof makeBridge>) => bridge as unknown as BudgetBridge;

  function setup() {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.state.ensureUser("u1", "C:\\work");
    bridge.state.update("u1", { sessionId: "wx-s1" });
    bridge.contextTokens.set("u1", "ctx-1");
    return bridge;
  }

  it("consumes the shared per-user budget on success", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    expect(b.wechatMsgCount.get("u1")).toBeUndefined();

    await bridge.handleSendWeChat("wx-s1", { text: "hello" });
    expect(b.wechatMsgCount.get("u1")).toBe(1);

    // Reply-path sends share the same counter.
    await b.sendReply("u1", "reply");
    expect(b.wechatMsgCount.get("u1")).toBe(2);
  });

  it("queues instead of sending once the budget is exhausted", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    b.wechatMsgCount.set("u1", 10);

    const result = await bridge.handleSendWeChat("wx-s1", { text: "overflow" });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/queued/i);
    // No payload delivery — the only send is the 💾 cache notice.
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [to, notice] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(to).toBe("u1");
    expect(notice).toContain("暂存待发");
    // The queued item sits in the outbound cache verbatim.
    expect(b.outboundCache.get("u1")).toHaveLength(1);
    expect(b.outboundCache.get("u1")![0]).toMatchObject({ kind: "text", text: "overflow" });
  });

  it("reply-path sends after tool pushes share the same 10-slot budget", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    for (let i = 0; i < 10; i++) {
      await bridge.handleSendWeChat("wx-s1", { text: `m${i}` });
    }
    // Ten direct deliveries, no caching notice yet.
    expect(sendTextMessage).toHaveBeenCalledTimes(10);

    // The 11th push — via the reply path — must queue and fire the notice.
    await b.sendReply("u1", "eleventh");
    expect(sendTextMessage).toHaveBeenCalledTimes(11);
    const [, notice] = sendTextMessage.mock.calls[10]! as [string, string];
    expect(notice).toContain("暂存待发");
    expect(b.outboundCache.get("u1")!.map((c) => c.text)).toContain("eleventh");
  });

  it("transient send failure parks the message and reports queued", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    sendTextMessage.mockRejectedValueOnce(new Error("gateway 429"));

    const result = await bridge.handleSendWeChat("wx-s1", { text: "flaky" });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/queued/i);
    expect(b.outboundCache.get("u1")).toHaveLength(1);
    expect(b.outboundCache.get("u1")![0]).toMatchObject({ kind: "text", text: "flaky" });
  });

  it("queued tool text is delivered by flushPending", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    b.wechatMsgCount.set("u1", 10);
    await bridge.handleSendWeChat("wx-s1", { text: "overflow" });
    sendTextMessage.mockClear();

    b.wechatMsgCount.set("u1", 0);
    await b.flushPending("u1");

    // Flushed payload first, then the flush summary via sendReply.
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    const [, flushed] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(flushed).toBe("overflow");
    expect(b.outboundCache.has("u1")).toBe(false);
  });

  it("a cached image file re-flushes with its native IMAGE media type", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    const tmpPng = path.join(os.tmpdir(), `send-wechat-${Date.now()}.png`);
    fs.writeFileSync(tmpPng, "png-bytes");
    try {
      b.wechatMsgCount.set("u1", 10);
      const result = await bridge.handleSendWeChat("wx-s1", { file_path: tmpPng });
      // Queued, not sent — no CDN upload attempted while over budget.
      expect(sendMediaMessage).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/^queued image/);

      sendMediaMessage.mockClear();
      b.wechatMsgCount.set("u1", 0);
      await b.flushPending("u1");
      expect(sendMediaMessage).toHaveBeenCalledTimes(1);
      const [, mediaType] = sendMediaMessage.mock.calls[0]! as [string, number, Buffer, unknown];
      // Inline image on flush — not degraded to FILE(3).
      expect(mediaType).toBe(UploadMediaType.IMAGE);
    } finally {
      fs.unlinkSync(tmpPng);
    }
  });

  it("nonexistent file_path returns ok:false immediately and touches no cache", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    const missing = path.join(os.tmpdir(), `send-wechat-missing-${Date.now()}.bin`);

    const result = await bridge.handleSendWeChat("wx-s1", { file_path: missing });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("file not found");
    // Not even the 💾 notice: nothing was parked.
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(sendMediaMessage).not.toHaveBeenCalled();
    expect(b.outboundCache.has("u1")).toBe(false);
  });
});