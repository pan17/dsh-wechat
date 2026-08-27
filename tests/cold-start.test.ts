/**
 * Bot-token gate + outbound cache cap.
 *
 * Context tokens are no longer a send gate. Missing / invalid bot tokens
 * drop outbound (no park). Rate-limit overflow still uses outboundCache.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";
import type { UserState } from "../src/state.js";

function makeMockAgent(id: string) {
  const received: Array<{ content: unknown; source: unknown }> = [];
  return {
    agent: {
      id,
      status: "idle",
      options: { provider: "deepseek", model: "deepseek-chat" },
      followup: (m: { content: unknown; source: unknown }) => received.push(m),
      steer: () => {},
      cancel: () => {},
      whenIdle: async () => {},
    },
    received,
  };
}

function makeBridge(agent: { agent: unknown; received: unknown[] }, loggedIn: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-cold-"));
  const agentsService = {
    create: async () => agent,
    resume: async () => agent,
    get: (id: string) => (id === (agent.agent as { id: string }).id ? agent.agent : undefined),
    list: () => [agent.agent],
  };
  const ctx = {
    get: (name: string) => (name === "agents" ? agentsService : undefined),
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  if (loggedIn) {
    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw",
      token: "t",
      accountId: "b1",
      userId: "u",
      savedAt: "",
    };
  }
  return { bridge, storageDir: dir };
}

function assistantEvent(text: string) {
  return {
    type: "assistant/message",
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { content: [{ type: "text", text }] } },
  };
}

function bindUser(store: { ensureUser(u: string, c: string): UserState }, sessionId: string): void {
  store.ensureUser("u1", "C:\\work");
  (store as unknown as { update(u: string, p: unknown): void }).update("u1", { sessionId });
}

describe("bot token missing: drop outbound, do not park", () => {
  let logs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("assistant/message does not send and does not grow outboundCache", () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, false);
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): UserState; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      outboundCache: Array<{ kind: string; text?: string }>;
    };
    bindUser(anyBridge.state, "wx-s1");

    anyBridge.handleSessionEvent("wx-s1", assistantEvent("离线期间生成的回复"));
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(anyBridge.outboundCache).toHaveLength(0);
    expect(logs.some((l) => l.includes("drop outbound (bot token missing)"))).toBe(true);
  });

  it("logout discards queued outbound so a later inbound does not flush GUI replies", async () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, true);
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): UserState; update(u: string, p: unknown): void };
      parkOutbound(userId: string, item: { kind: "text"; text: string }): void;
      outboundCache: Array<{ kind: string; text?: string }>;
      silentBuffers: Map<string, string[]>;
      logout(): Promise<{ ok: boolean; message: string }>;
      handleMessage(m: unknown): Promise<void>;
    };
    bindUser(anyBridge.state, "wx-s1");
    anyBridge.parkOutbound("u1", { kind: "text", text: "登出前暂存的 GUI 回复" });
    anyBridge.silentBuffers.set("wx-s1", ["静默缓冲"]);

    await anyBridge.logout();
    expect(anyBridge.outboundCache.length).toBe(0);
    expect(anyBridge.silentBuffers.size).toBe(0);

    sendTextMessage.mockClear();
    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw",
      token: "t",
      accountId: "b1",
      userId: "u",
      savedAt: "",
    };
    await anyBridge.handleMessage({
      message_type: 1,
      from_user_id: "u1",
      context_token: "ctx",
      item_list: [{ type: 1, text_item: { text: "我回来了" } }],
    });
    const leaked = sendTextMessage.mock.calls.some((c) => String(c[1]).includes("登出前暂存的 GUI 回复"));
    expect(leaked).toBe(false);
  });
});

describe("-14 park then flush on recover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parks assistant text while tokenInvalid and flushes on recover", async () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, true);
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): UserState; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      outboundCache: Array<{ kind: string; text?: string }>;
      tokenInvalid: boolean;
      markTokenRecovered(): void;
    };
    bindUser(anyBridge.state, "wx-s1");
    anyBridge.tokenInvalid = true;

    anyBridge.handleSessionEvent("wx-s1", assistantEvent("-14 期间的回复"));
    await new Promise((r) => setImmediate(r));
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(anyBridge.outboundCache[0]?.text).toContain("-14 期间的回复");

    anyBridge.markTokenRecovered();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(sendTextMessage.mock.calls.some((c) => String(c[1]).includes("-14 期间的回复"))).toBe(true);
    expect(anyBridge.outboundCache).toHaveLength(0);
  });

  it("give-up discards parked items instead of flushing later", async () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, true);
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): UserState; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      outboundCache: Array<{ kind: string; text?: string }>;
      tokenInvalid: boolean;
      markTokenGiveUp(): void;
      markTokenRecovered(): void;
    };
    bindUser(anyBridge.state, "wx-s1");
    anyBridge.tokenInvalid = true;
    anyBridge.handleSessionEvent("wx-s1", assistantEvent("等恢复的回复"));
    await new Promise((r) => setImmediate(r));
    expect(anyBridge.outboundCache).toHaveLength(1);

    anyBridge.markTokenGiveUp();
    expect(anyBridge.outboundCache.length).toBe(0);

    sendTextMessage.mockClear();
    anyBridge.markTokenRecovered();
    await new Promise((r) => setImmediate(r));
    expect(sendTextMessage.mock.calls.some((c) => String(c[1]).includes("等恢复的回复"))).toBe(false);
  });
});

describe("bot token present: send even without a wire context_token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("assistant/message attempts sendTextMessage", async () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, true);
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): UserState; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    bindUser(anyBridge.state, "wx-s1");

    anyBridge.handleSessionEvent("wx-s1", assistantEvent("重启后的回复"));
    await new Promise((r) => setImmediate(r));
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("重启后的回复");
  });
});

describe("outbound cache cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parkOutbound drops the OLDEST items beyond the cap", () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, true);
    const anyBridge = bridge as unknown as {
      parkOutbound(userId: string, item: { kind: "text"; text: string }): void;
      outboundCache: Array<{ kind: string; text?: string }>;
    };
    for (let i = 0; i < 105; i++) {
      anyBridge.parkOutbound("u1", { kind: "text", text: `msg-${i}` });
    }
    const cache = anyBridge.outboundCache!;
    expect(cache).toHaveLength(100);
    expect(cache[0]!.text).toBe("msg-5");
    expect(cache[cache.length - 1]!.text).toBe("msg-104");
  });
});
