/**
 * End-to-end forwarding chain tests: WeChat message → agent.followup
 * (user message, kind 'user') → assistant/message event → sendTextMessage.
 * Both the agent registry and the WeChat send layer are mocked; this
 * verifies the code path the user reported broken ("no AI messages
 * received") without touching the network.
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

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";

/** A mock live agent that records followup messages. */
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

function makeBridge(agent: { agent: unknown; received: unknown[] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-fwd-"));
  const agentsService = {
    create: async () => agent,
    resume: async () => agent,
    get: (id: string) => (id === agent.agent.id ? agent.agent : undefined),
    list: () => [agent.agent],
  };
  const ctx = {
    get: (name: string) => (name === "agents" ? agentsService : undefined),
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  (bridge as unknown as { token: unknown }).token = { baseUrl: "https://gw", token: "t", accountId: "b1", userId: "u", savedAt: "" };
  return bridge;
}

function wechatTextMessage(text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "ctx-token",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

describe("WeChat → agent forwarding chain", () => {
  let bridge: WeChatDSHBridge;
  let mock: ReturnType<typeof makeMockAgent>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = makeMockAgent("wx-s1");
    bridge = makeBridge(mock);
  });

  it("user message is forwarded as a kind-'user' followup", async () => {
    const anyBridge = bridge as unknown as { handleMessage(m: unknown): Promise<void> };
    await anyBridge.handleMessage(wechatTextMessage("帮我看看这个项目"));
    expect(mock.received.length).toBe(1);
    const sent = mock.received[0]!;
    expect(sent.source).toEqual({ kind: "user" });
    expect((sent.content as Array<{ type: string; text?: string }>)[0]!.text).toBe("帮我看看这个项目");
  });

  it("assistant/message event is forwarded to WeChat via sendTextMessage", async () => {
    // Register the user binding the way handleMessage does.
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    (anyBridge.state as { update(u: string, p: unknown): void }).update("u1", { sessionId: "wx-s1" });

    // SessionEvent is the wrapped { type, seq, time, data } shape.
    anyBridge.handleSessionEvent("wx-s1", {
      type: "assistant/message",
      seq: 5,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: "text", text: "你好，这是回复" }] },
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [to, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(to).toBe("u1");
    expect(text).toContain("你好，这是回复");
  });

  it("assistant/message with only non-text content is skipped silently", () => {
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    (anyBridge.state as { update(u: string, p: unknown): void }).update("u1", { sessionId: "wx-s1" });
    anyBridge.handleSessionEvent("wx-s1", {
      type: "assistant/message",
      seq: 6,
      time: Date.now(),
      data: {
        turn: 1,
        step: 2,
        message: { content: [{ type: "tool_use", name: "x" }] },
      },
    });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("silent mode buffers and flushes only the last text on turn/end", async () => {
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    const state = anyBridge.state as { update(u: string, p: unknown): void; getUser(u: string): { silent: boolean } };
    state.update("u1", { sessionId: "wx-s1", silent: true });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "assistant/message",
      seq: 7,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "第一段" }] } },
    });
    anyBridge.handleSessionEvent("wx-s1", {
      type: "assistant/message",
      seq: 8,
      time: Date.now(),
      data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "最终回复" }] } },
    });
    expect(sendTextMessage).not.toHaveBeenCalled();

    anyBridge.handleSessionEvent("wx-s1", { type: "turn/end", seq: 9, time: Date.now(), data: { turn: 1, reason: "success" } });
    await new Promise((r) => setImmediate(r));
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("最终回复");
  });

  it("ignores inbound from a second WeChat user (single-user peer)", async () => {
    const anyBridge = bridge as unknown as { handleMessage(m: unknown): Promise<void> };
    await anyBridge.handleMessage(wechatTextMessage("先到先得"));
    expect(mock.received.length).toBe(1);

    await anyBridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u2",
      context_token: "other",
      item_list: [{ type: 1, text_item: { text: "第二个人" } }],
    });
    expect(mock.received.length).toBe(1);
  });
});
