/**
 * Push governance: the per-minute cap on agent-initiated `send_wechat`
 * pushes, and the inbound allowlist.
 *
 * Both are security-adjacent defaults:
 *   - the cap exists because a runaway agent can spend WeChat's whole
 *     10-message window on narration and leave no room for the answer, so a
 *     refusal has to be LOUD (ok:false) rather than a silent drop;
 *   - the allowlist is empty by default, which must reproduce the historical
 *     "first inbound user becomes the peer" behaviour byte for byte.
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
import { MessageType } from "../src/weixin/types.js";

const live: any[] = [];

function makeBridge(patch: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-gov-"));
  const agentsService = {
    create: async () => undefined,
    resume: async () => undefined,
    get: () => undefined,
    list: () => [],
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  Object.assign(cfg, patch);
  const bridge = new WeChatDSHBridge(
    { get: (name: string) => (name === "agents" ? agentsService : undefined), on: () => () => {} },
    cfg,
  );
  (bridge as any).token = { baseUrl: "https://gw", token: "t", accountId: "b1", userId: "bot", savedAt: "" };
  // `send_wechat` resolves its recipient through the bound user list, so the
  // rate-limit cases need one existing WeChat user to push to.
  (bridge as any).state.ensureUser("u1", "C:\\work");
  (bridge as any).state.update("u1", { sessionId: "wx-s1" });
  live.push(bridge);
  return bridge as any;
}

function userText(text: string, from = "u1") {
  return {
    message_type: MessageType.USER,
    from_user_id: from,
    context_token: "tok",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

const texts = () => sendTextMessage.mock.calls.map((c: any) => c[1] as string);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const bridge of live.splice(0)) await bridge.stop().catch(() => {});
});

describe("send_wechat per-minute rate limit", () => {
  it("defaults to 10 per minute", () => {
    expect(defaultConfig().sendWechatRateLimitPerMinute).toBe(10);
  });

  it("accepts pushes under the limit", async () => {
    const bridge = makeBridge({ sendWechatRateLimitPerMinute: 3 });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await bridge.handleSendWeChat("wx-s1", { text: `m${i}` }));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledTimes(3);
  });

  it("refuses the push over the limit and tells the model to stop", async () => {
    const bridge = makeBridge({ sendWechatRateLimitPerMinute: 2 });
    await bridge.handleSendWeChat("wx-s1", { text: "one" });
    await bridge.handleSendWeChat("wx-s1", { text: "two" });
    const refused = await bridge.handleSendWeChat("wx-s1", { text: "three" });

    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/rate limited/i);
    expect(refused.message).toMatch(/do not keep pushing/i);
    expect(refused.message).toContain("2");
    // Refused means NOT sent.
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(texts()).not.toContain("three");
  });

  it("counts media pushes too — the tool call is what is limited", async () => {
    const bridge = makeBridge({ sendWechatRateLimitPerMinute: 1 });
    // A file the tool is allowed to read: inside the sending session's cwd
    // (the S2 bound refuses anything else, which would confuse the limiter).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-rate-file-"));
    (bridge as any).state.update("u1", { cwd: dir });
    const tmp = path.join(dir, `dsh-wx-rate-${Date.now()}.txt`);
    fs.writeFileSync(tmp, "payload");
    try {
      const first = await bridge.handleSendWeChat("wx-s1", { file_path: tmp });
      const second = await bridge.handleSendWeChat("wx-s1", { file_path: tmp });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not extend the window on a refusal", async () => {
    vi.useFakeTimers();
    try {
      const bridge = makeBridge({ sendWechatRateLimitPerMinute: 1 });
      const first = await bridge.handleSendWeChat("wx-s1", { text: "a" });
      expect(first.ok).toBe(true);
      // Hammer the limiter; none of these may be counted.
      for (let i = 0; i < 5; i++) {
        expect((await bridge.handleSendWeChat("wx-s1", { text: "x" })).ok).toBe(false);
      }
      vi.advanceTimersByTime(60_001);
      const after = await bridge.handleSendWeChat("wx-s1", { text: "b" });
      expect(after.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("0 disables the limit (the gateway window still applies)", async () => {
    const bridge = makeBridge({ sendWechatRateLimitPerMinute: 0 });
    for (let i = 0; i < 25; i++) {
      expect((await bridge.handleSendWeChat("wx-s1", { text: `m${i}` })).ok).toBe(true);
    }
    // No refusal: 0 means unlimited. WeChat's own 10-message window still
    // caps direct sends, and the rest is parked rather than dropped.
    expect(texts().some((t) => /rate limited/i.test(t))).toBe(false);
    expect(sendTextMessage.mock.calls.length).toBe(10);
  });

  it("leaves assistant replies unthrottled — only the tool path is gated", async () => {
    const bridge = makeBridge({ sendWechatRateLimitPerMinute: 1 });
    await bridge.handleSendWeChat("wx-s1", { text: "push" });
    expect((await bridge.handleSendWeChat("wx-s1", { text: "push2" })).ok).toBe(false);
    // The user's own answer still goes out.
    await bridge.sendReply("u1", "assistant reply");
    expect(texts()).toContain("assistant reply");
  });
});

describe("inbound allowlist", () => {
  it("an empty list keeps the first-user-wins behaviour", async () => {
    const bridge = makeBridge({ allowedUsers: [] });
    await bridge.handleMessage(userText("你好"));
    // The user became the peer and the message reached the agent path.
    expect(bridge.peerUserId).toBe("u1");
    expect(bridge.state.all().map((u: any) => u.userId)).toEqual(["u1"]);
  });

  it("a listed user passes", async () => {
    const bridge = makeBridge({ allowedUsers: ["u1"] });
    (bridge as any).state.clearUsers();
    (bridge as any).peerUserId = null;
    await bridge.handleMessage(userText("/status"));
    expect(bridge.peerUserId).toBe("u1");
    expect(sendTextMessage).toHaveBeenCalled();
  });

  it("an unlisted user is dropped with NO outbound message", async () => {
    const bridge = makeBridge({ allowedUsers: ["someone-else"] });
    (bridge as any).state.clearUsers();
    (bridge as any).peerUserId = null;
    await bridge.handleMessage(userText("让我进去", "intruder"));
    await sleep(10);
    expect(bridge.peerUserId).toBeNull();
    expect(sendTextMessage).not.toHaveBeenCalled();
    // No binding, no session, no agent turn was created for the sender.
    expect(bridge.state.all()).toEqual([]);
  });

  it("a rejected sender is refused before any command handling", async () => {
    const bridge = makeBridge({ allowedUsers: ["u1"] });
    // `/status` would answer if the command layer ran; it must not.
    await bridge.handleMessage(userText("/status", "intruder"));
    await bridge.handleMessage(userText("/next", "intruder"));
    await bridge.handleMessage(userText("/help", "intruder"));
    await sleep(10);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("a rejected sender does not consume the peer slot", async () => {
    const bridge = makeBridge({ allowedUsers: ["u1"] });
    (bridge as any).state.clearUsers();
    (bridge as any).peerUserId = null;
    await bridge.handleMessage(userText("先到", "intruder"));
    await bridge.handleMessage(userText("/status", "u1"));
    expect(bridge.peerUserId).toBe("u1");
    expect(sendTextMessage).toHaveBeenCalled();
  });

  it("logs the rejected id MASKED so the operator can correlate without leaking it", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const bridge = makeBridge({ allowedUsers: ["u1"] });
      await bridge.handleMessage(userText("让我进去", "intruder-42"));
      // S4: the operator sees the rejection and can correlate it with other
      // lines about the same sender, but the log never carries the raw id.
      expect(logs.some((l) => l.includes("in***42") && l.includes("allowedUsers"))).toBe(true);
      expect(logs.some((l) => l.includes("intruder-42"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
