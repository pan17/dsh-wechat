/**
 * `send_wechat` tool — recipient resolution:
 *
 *   - bound session sends to the bound user (existing behavior)
 *   - unbound session falls back to the first known WeChat user
 *     (single-user deployments are the norm)
 *   - no known users at all → returns a clear error
 *   - WeChat not logged in → returns "WeChat is not logged in"
 *   - invalid bot token → returns "WeChat bot token is invalid"
 *   - empty / unknown agentId → falls back gracefully (no throw)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendMediaMessage = vi.fn().mockResolvedValue(undefined);
const isMessageLimitError = vi.fn().mockReturnValue(false);
const isInvalidRequestError = vi.fn().mockReturnValue(false);

vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
  sendMediaMessage: (...args: unknown[]) => sendMediaMessage(...args),
  splitText: (text: string, maxLen: number) =>
    text.length <= maxLen ? [text] : [text.slice(0, maxLen), text.slice(maxLen)],
}));

vi.mock("../src/weixin/api.js", () => ({
  sendTyping: () => Promise.resolve(undefined),
  getConfig: () => Promise.resolve({ typing_ticket: "tk-default" }),
  isSessionTimeoutError: () => false,
  isMessageLimitError: (err: unknown) => isMessageLimitError(err),
  isInvalidRequestError: (err: unknown) => isInvalidRequestError(err),
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
    tokenInvalid: boolean;
    tokenGiveUp: boolean;
    wireContextToken: string | null;
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
  isMessageLimitError.mockReturnValue(false);
  isInvalidRequestError.mockReturnValue(false);
});

describe("send_wechat: bound session", () => {
  it("sends text to the user bound to the calling session", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.state.ensureUser("u1", "C:\\work");
    bridge.state.update("u1", { sessionId: "wx-s1" });
    bridge.wireContextToken = "ctx-1";

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
    bridge.wireContextToken = "ctx-1";

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
    bridge.wireContextToken = "ctx-1";

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
    bridge.wireContextToken = "ctx-1";

    // Calling from a session bound to NOTHING → fallback should pick u1.
    const result = await bridge.handleSendWeChat("gui-session-xyz", { text: "ping" });
    expect(result.ok).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledWith("u1", "ping", expect.objectContaining({ contextToken: "ctx-1" }));
  });

  it("empty agentId falls back gracefully (no throw)", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.state.ensureUser("u1", "C:\\work");
    bridge.wireContextToken = "ctx-1";

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

    const result = await bridge.handleSendWeChat("wx-s1", { text: "hi" });
    expect(result).toEqual({ ok: false, message: "WeChat is not logged in" });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("queues text while -14 is recovering", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.tokenInvalid = true;
    bridge.state.ensureUser("u1", "C:\\work");

    const result = await bridge.handleSendWeChat("gui-session-xyz", { text: "hi" });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/queued/i);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("returns invalid-token after -14 recovery gives up", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.tokenGiveUp = true;
    bridge.state.ensureUser("u1", "C:\\work");

    const result = await bridge.handleSendWeChat("gui-session-xyz", { text: "hi" });
    expect(result).toEqual({ ok: false, message: "WeChat bot token is invalid; re-scan the QR code" });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("returns an error when neither text nor file_path is provided", async () => {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.state.ensureUser("u1", "C:\\work");

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
// of being lost. A full 10-slot window does not attempt an 11th cache
// notice; doing so would only reproduce the gateway's prepare-failed error.

describe("send_wechat: shared gateway budget & cache", () => {
  interface BudgetBridge {
    wechatMsgCount: number;
    outboundCache: Array<{ kind: string; text?: string; filePath?: string; fileName?: string }>;
    sendReply(userId: string, text: string): Promise<void>;
    flushPending(userId: string): Promise<void>;
  }
  const asBudget = (bridge: ReturnType<typeof makeBridge>) => bridge as unknown as BudgetBridge;

  function setup() {
    const bridge = makeBridge();
    setLoggedIn(bridge);
    bridge.state.ensureUser("u1", "C:\\work");
    bridge.state.update("u1", { sessionId: "wx-s1" });
    return bridge;
  }

  it("consumes the shared per-user budget on success", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    expect(b.wechatMsgCount).toBe(0);

    await bridge.handleSendWeChat("wx-s1", { text: "hello" });
    expect(b.wechatMsgCount).toBe(1);

    // Reply-path sends share the same counter.
    await b.sendReply("u1", "reply");
    expect(b.wechatMsgCount).toBe(2);
  });

  it("restores the one budget and FIFO from state.json after restart", async () => {
    const first = setup();
    const firstBudget = asBudget(first);
    firstBudget.wechatMsgCount = 5;
    await first.handleSendWeChat("wx-s1", { text: "sixth" });
    firstBudget.wechatMsgCount = 10;
    await first.handleSendWeChat("wx-s1", { text: "pending-after-restart" });

    const storageDir = (first as unknown as { config: { storageDir: string } }).config.storageDir;
    const cfg = defaultConfig();
    cfg.storageDir = storageDir;
    const agentsService = { create: async () => undefined, resume: async () => undefined, get: () => undefined, list: () => [] };
    const restarted = new WeChatDSHBridge({
      get: (name: string) => (name === "agents" ? agentsService : undefined),
      on: () => () => {},
    }, cfg) as unknown as BudgetBridge;

    expect(restarted.wechatMsgCount).toBe(10);
    expect(restarted.outboundCache).toEqual([{ kind: "text", text: "pending-after-restart" }]);
  });

  it("queues instead of sending once the budget is exhausted", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    b.wechatMsgCount = 10;

    const result = await bridge.handleSendWeChat("wx-s1", { text: "overflow" });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/queued/i);
    // No payload and no 11th notice: the gateway window is already closed.
    expect(sendTextMessage).not.toHaveBeenCalled();
    // The queued item sits in the outbound cache verbatim.
    expect(b.outboundCache).toHaveLength(1);
    expect(b.outboundCache![0]).toMatchObject({ kind: "text", text: "overflow" });
  });

  it("reply-path sends after tool pushes share the same 10-slot budget", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    for (let i = 0; i < 10; i++) {
      await bridge.handleSendWeChat("wx-s1", { text: `m${i}` });
    }
    // Ten direct deliveries, no caching notice yet.
    expect(sendTextMessage).toHaveBeenCalledTimes(10);

    // The 11th push queues without making an 11th gateway request.
    await b.sendReply("u1", "eleventh");
    expect(sendTextMessage).toHaveBeenCalledTimes(10);
    expect(b.outboundCache!.map((c) => c.text)).toContain("eleventh");
  });

  it("real prepare-failed response calibrates the window to 10 and parks once", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    const limitError = new Error("ilink/bot/sendmessage: ret=-2 prepare failed");
    sendTextMessage.mockRejectedValueOnce(limitError);
    isMessageLimitError.mockImplementation((err) => err === limitError);

    const result = await bridge.handleSendWeChat("wx-s1", { text: "real-eleventh" });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/queued/i);
    expect(b.wechatMsgCount).toBe(10);
    expect(b.outboundCache).toEqual([{ kind: "text", text: "real-eleventh" }]);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);

    await bridge.handleSendWeChat("wx-s1", { text: "after-limit" });
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(b.outboundCache.map((item) => item.text)).toEqual(["real-eleventh", "after-limit"]);
  });

  it("transient send failure parks the message and reports queued", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    sendTextMessage.mockRejectedValueOnce(new Error("gateway 429"));

    const result = await bridge.handleSendWeChat("wx-s1", { text: "flaky" });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/queued/i);
    expect(b.outboundCache).toHaveLength(1);
    expect(b.outboundCache![0]).toMatchObject({ kind: "text", text: "flaky" });
  });

  it("flush drops invalid-request payloads and continues with the rest", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    const invalid = Object.assign(new Error("ilink/bot/sendmessage: ret=-1 invalid request"), { name: "IlinkApiError" });
    b.outboundCache = [
      { kind: "text", text: "poisoned-status" },
      { kind: "text", text: "good-payload" },
    ];
    sendTextMessage.mockImplementation(async (_to: string, text: string) => {
      if (text === "poisoned-status") throw invalid;
    });
    isInvalidRequestError.mockImplementation((err) => err === invalid);

    await b.flushPending("u1");

    const sent = sendTextMessage.mock.calls.map((c) => String(c[1]));
    expect(sent).toContain("good-payload");
    expect(b.outboundCache.some((item) => item.text === "poisoned-status")).toBe(false);
  });

  it("flush leftover summary is not parked when its own send fails", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    b.wechatMsgCount = 10;
    await bridge.handleSendWeChat("wx-s1", { text: "stuck-payload" });
    expect(b.outboundCache).toEqual([{ kind: "text", text: "stuck-payload" }]);

    b.wechatMsgCount = 0;
    sendTextMessage.mockRejectedValue(new Error("gateway 429"));
    await b.flushPending("u1");

    expect(b.outboundCache).toEqual([{ kind: "text", text: "stuck-payload" }]);
    expect(b.outboundCache.some((item) => String(item.text).includes("已发送"))).toBe(false);
    expect(b.outboundCache.some((item) => String(item.text).includes("暂存待发"))).toBe(false);
  });

  it("/status auto-flush does not grow the cache with status or leftover summaries", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    b.wechatMsgCount = 10;
    await bridge.handleSendWeChat("wx-s1", { text: "stuck-payload" });
    sendTextMessage.mockClear();
    sendTextMessage.mockRejectedValue(new Error("gateway 429"));

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage({
      message_type: 1,
      from_user_id: "u1",
      context_token: "tok",
      item_list: [{ type: 1, text_item: { text: "/status" } }],
    });

    expect(b.outboundCache).toEqual([{ kind: "text", text: "stuck-payload" }]);
    expect(b.outboundCache.some((item) => String(item.text).includes("已发送"))).toBe(false);
    expect(b.outboundCache.some((item) => String(item.text).includes("当前状态"))).toBe(false);
  });

  it("queued tool text is delivered by flushPending", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    b.wechatMsgCount = 10;
    await bridge.handleSendWeChat("wx-s1", { text: "overflow" });
    sendTextMessage.mockClear();

    b.wechatMsgCount = 0;
    await b.flushPending("u1");

    // Flushed payload first, then the flush summary via sendReply.
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    const [, flushed] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(flushed).toBe("overflow");
    expect(b.outboundCache.length > 0).toBe(false);
  });

  it("a cached image file re-flushes with its native IMAGE media type", async () => {
    const bridge = setup();
    const b = asBudget(bridge);
    const tmpPng = path.join(os.tmpdir(), `send-wechat-${Date.now()}.png`);
    fs.writeFileSync(tmpPng, "png-bytes");
    try {
      b.wechatMsgCount = 10;
      const result = await bridge.handleSendWeChat("wx-s1", { file_path: tmpPng });
      // Queued, not sent — no CDN upload attempted while over budget.
      expect(sendMediaMessage).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/^queued image/);

      sendMediaMessage.mockClear();
      b.wechatMsgCount = 0;
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
    expect(b.outboundCache.length > 0).toBe(false);
  });
});