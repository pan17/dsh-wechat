/**
 * Delivery hardening wave — S5, R1, R2, R3.
 *
 * Each case drives a real public entry and (where a lock is involved) asserts
 * SETTLEMENT WITHIN A TIMEOUT: a direct-helper test cannot observe a
 * serialization slot that never resolves.
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

vi.mock("../src/weixin/api.js", () => ({
  sendTyping: () => Promise.resolve(undefined),
  getConfig: () => Promise.resolve({ typing_ticket: "tk" }),
  isSessionTimeoutError: () => false,
  isMessageLimitError: () => false,
  isInvalidRequestError: () => false,
}));

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";

const live: Array<{ stop(): Promise<void> }> = [];

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const agent = {
  id: "wx-s1",
  status: "idle" as const,
  options: { provider: "deepseek", model: "deepseek-chat" },
  followup: () => {},
  steer: () => {},
  cancel: () => {},
  whenIdle: async () => {},
};

function makeBridge(patch: Record<string, unknown> = {}, ctxExtra: Record<string, unknown> = {}) {
  const dir = tmpDir("dsh-wx-resil-");
  const services: Record<string, unknown> = {
    agents: {
      get: (id: string) => (id === "wx-s1" ? agent : undefined),
      create: async () => ({ agent }),
      resume: async () => ({ agent }),
      list: () => [agent],
    },
    ...ctxExtra,
  };
  const bridge = new WeChatDSHBridge(
    { get: (name: string) => services[name], on: () => () => {} },
    { ...defaultConfig(), storageDir: dir, mergeSilenceMs: 0, ...patch },
  );
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "bot",
    savedAt: "",
  };
  (bridge as any).state.ensureUser("u1", dir);
  (bridge as any).state.update("u1", { sessionId: "wx-s1" });
  live.push(bridge);
  return { bridge, dir };
}

/** Race a promise against a deadline; resolves to "timeout" when it hangs. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const asInbound = (bridge: unknown) => bridge as { handleMessage(m: unknown): Promise<void> };
const textMessage = (text: string, messageId?: number) => ({
  message_type: MessageType.USER,
  from_user_id: "u1",
  context_token: "tok",
  ...(messageId !== undefined ? { message_id: messageId } : {}),
  item_list: [{ type: 1, text_item: { text } }],
});
const replies = () => sendTextMessage.mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const bridge of live.splice(0)) await bridge.stop().catch(() => {});
});

// ─── S5: a card is marked pushed only when it can actually be pushed ───

function seedApprovalCard(bridge: unknown, rpcId = "rpc-1", toolName = "pwsh") {
  (bridge as { handleMuxFrame(f: unknown): void }).handleMuxFrame({
    type: "server-request",
    rpcId,
    method: "approval/request",
    payload: { type: "approval/requested", sessionId: "wx-s1", approvalId: `appr-${rpcId}`, toolName },
  });
}

describe("S5 — card reachability is confirmed before the pushed-mark is taken", () => {
  it("does not claim the mark while the bot is logged out, and delivers on recovery", async () => {
    const { bridge } = makeBridge();
    const anyBridge = bridge as unknown as {
      token: unknown;
      isCardPushed(userId: string, rpcId: string): boolean;
    };
    const savedToken = anyBridge.token;
    anyBridge.token = null; // logged out: sendReply DROPS rather than parks

    seedApprovalCard(bridge);
    expect(sendTextMessage).not.toHaveBeenCalled();
    // The fix under test: the one-shot mark is NOT taken for a delivery that
    // never happened, so a later attempt can still push the card.
    expect(anyBridge.isCardPushed("u1", "rpc-1")).toBe(false);

    // Recovery, then the normal "push every unseen card" path.
    anyBridge.token = savedToken;
    await asInbound(bridge).handleMessage(textMessage("/notify on"));
    expect(replies().some((r) => r.includes("pwsh"))).toBe(true);
    expect(anyBridge.isCardPushed("u1", "rpc-1")).toBe(true);
  });

  it("does not claim the mark after -14 give-up either", () => {
    const { bridge } = makeBridge();
    const anyBridge = bridge as unknown as {
      tokenGiveUp: boolean;
      isCardPushed(userId: string, rpcId: string): boolean;
    };
    anyBridge.tokenGiveUp = true;
    seedApprovalCard(bridge, "rpc-2");
    expect(anyBridge.isCardPushed("u1", "rpc-2")).toBe(false);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("rolls the mark back when the push itself fails", async () => {
    const { bridge } = makeBridge();
    const anyBridge = bridge as unknown as {
      isCardPushed(userId: string, rpcId: string): boolean;
    };
    vi.spyOn(bridge as never, "sendApprovalCard" as never).mockRejectedValue(new Error("boom") as never);
    seedApprovalCard(bridge, "rpc-3");
    await sleep(10);
    expect(anyBridge.isCardPushed("u1", "rpc-3")).toBe(false);
  });

  it("still marks a card that WAS delivered", async () => {
    const { bridge } = makeBridge();
    const anyBridge = bridge as unknown as { isCardPushed(userId: string, rpcId: string): boolean };
    seedApprovalCard(bridge, "rpc-4");
    await sleep(10);
    expect(anyBridge.isCardPushed("u1", "rpc-4")).toBe(true);
    expect(replies().some((r) => r.includes("pwsh"))).toBe(true);
  });
});

// ─── R1: the outbound slot fails loudly and cannot wedge the channel ───

describe("R1 — outbound serialization fails loudly, with an escape", () => {
  it("a public entry called from inside the locked body is refused instead of deadlocking", async () => {
    const { bridge } = makeBridge();
    let reentryError: unknown;
    let outerSettled = false;
    sendTextMessage.mockImplementation(async () => {
      // The exact defect class: a public (lock-acquiring) entry reached from
      // inside the body that already holds the slot.
      try {
        await (bridge as never as { sendReply(u: string, t: string): Promise<void> }).sendReply("u1", "nested");
      } catch (err) {
        reentryError = err;
      }
    });

    const outcome = await within(
      bridge.handleSendWeChat("wx-s1", { text: "outer" }),
      3000,
    ).then((result) => {
      outerSettled = result !== "timeout";
      return result;
    });
    expect(outerSettled).toBe(true);
    expect(outcome).not.toBe("timeout");
    expect((reentryError as Error)?.message).toMatch(/re-entered/);

    // The chain is still usable afterwards (no wedge, no poisoned tail).
    sendTextMessage.mockResolvedValue(undefined);
    const after = await within(
      (bridge as never as { sendReply(u: string, t: string): Promise<void> }).sendReply("u1", "after"),
      3000,
    );
    expect(after).not.toBe("timeout");
    expect(replies()).toContain("after");
  });

  it("a hung outbound operation cannot block every later send (bounded wait)", async () => {
    const { bridge } = makeBridge();
    const anyBridge = bridge as unknown as {
      outboundSlotWaitMs: number;
      sendReply(u: string, t: string): Promise<void>;
    };
    anyBridge.outboundSlotWaitMs = 100;
    let call = 0;
    sendTextMessage.mockImplementation(async () => {
      call++;
      if (call === 1) await new Promise(() => {}); // never settles
    });

    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.map(String).join(" ")));
    try {
      void anyBridge.sendReply("u1", "hung");
      await sleep(20);
      const second = await within(anyBridge.sendReply("u1", "later"), 2000);
      expect(second).not.toBe("timeout");
    } finally {
      spy.mockRestore();
    }
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.includes("outbound slot still held"))).toBe(true);
  });
});

// ─── R2: the per-session maps are bounded ───

describe("R2 — bounded per-session maps", () => {
  it("caps lastAssistantTextBySession and evicts the oldest deterministically", () => {
    const { bridge } = makeBridge();
    const anyBridge = bridge as unknown as {
      lastAssistantTextBySession: Map<string, string>;
      handleSessionEvent(sessionId: string, event: unknown): void;
    };
    for (let i = 0; i < 70; i++) {
      anyBridge.handleSessionEvent(`s-${i}`, {
        type: "assistant/message",
        seq: i,
        time: Date.now(),
        data: { turn: 1, step: 1, message: { content: [{ type: "text", text: `body-${i}` }] } },
      });
    }
    const map = anyBridge.lastAssistantTextBySession;
    expect(map.size).toBeLessThanOrEqual(64);
    expect(map.has("s-0")).toBe(false); // oldest evicted
    expect(map.get("s-69")).toBe("body-69"); // newest kept
  });

  it("caps lastActivityBySession while keeping the newest sessions", () => {
    const { bridge } = makeBridge();
    const anyBridge = bridge as unknown as {
      lastActivityBySession: Map<string, number>;
      handleSessionEvent(sessionId: string, event: unknown): void;
    };
    for (let i = 0; i < 520; i++) {
      anyBridge.handleSessionEvent(`act-${i}`, {
        type: "user/message",
        seq: i,
        time: 1_000 + i,
        data: { source: { kind: "user" } },
      });
    }
    const map = anyBridge.lastActivityBySession;
    expect(map.size).toBeLessThanOrEqual(512);
    expect(map.has("act-0")).toBe(false);
    expect(map.get("act-519")).toBe(1_000 + 519);
  });

  it("expires a WeChat message-id mark that is never echoed (TTL), via the real inbound entry", async () => {
    vi.useFakeTimers();
    const { bridge } = makeBridge();
    const anyBridge = bridge as unknown as { wechatMessageIds: Map<string, number> };
    await asInbound(bridge).handleMessage(textMessage("你好", 9_001));
    expect(anyBridge.wechatMessageIds.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 5);
    // The mark is one-shot with an armed release: an echo that never arrives
    // must not pin the id for the process lifetime.
    expect(anyBridge.wechatMessageIds.size).toBe(0);
  });

  it("caps wechatMessageIds as a hard ceiling above the TTL", () => {
    const { bridge } = makeBridge();
    const anyBridge = bridge as unknown as {
      wechatMessageIds: Map<string, number>;
      markWechatMessage(id: string): void;
    };
    for (let i = 0; i < 600; i++) anyBridge.markWechatMessage(`id-${i}`);
    expect(anyBridge.wechatMessageIds.size).toBeLessThanOrEqual(512);
    expect(anyBridge.wechatMessageIds.has("id-0")).toBe(false);
    expect(anyBridge.wechatMessageIds.has("id-599")).toBe(true);
  });

  it("caps modelOverrides and keeps the newest sessions' overrides", async () => {
    const llm = {
      listProviders: () => [{ id: "deepseek", name: "DeepSeek" }],
      listModels: async () => [{ provider: "deepseek", id: "deepseek-chat", name: "Chat" }],
      resolveModelInfo: async () => ({ reasoning: undefined }),
    };
    // Each `sess-N` gets its own live agent, so the override is keyed by the
    // session the command actually ran against.
    const agents = {
      get: (id: string) => (id.startsWith("sess-") ? { ...agent, id } : undefined),
      create: async () => ({ agent }),
      resume: async () => ({ agent }),
      list: () => [agent],
    };
    const { bridge } = makeBridge({}, {
      llm,
      agents,
      agentDefaultModel: { currentSelection: () => undefined, saveSelection: async () => {} },
    });
    const anyBridge = bridge as unknown as { modelOverrides: Map<string, unknown> };
    // Drive the real command so the cap is exercised through its actual writer.
    for (let i = 0; i < 130; i++) {
      (bridge as any).state.update("u1", { sessionId: `sess-${i}` });
      await asInbound(bridge).handleMessage(textMessage("/model switch deepseek/deepseek-chat"));
    }
    expect(anyBridge.modelOverrides.size).toBeLessThanOrEqual(128);
    expect(anyBridge.modelOverrides.has("sess-0")).toBe(false);
    expect(anyBridge.modelOverrides.has("sess-129")).toBe(true);
  });
});

// ─── R3: a restart restores the whole bounded queue ───

describe("R3 — state.json reload keeps the whole bounded outbound queue", () => {
  it("restores 150 queued items instead of truncating to the last 100", () => {
    const dir = tmpDir("dsh-wx-restore-");
    const queue = Array.from({ length: 150 }, (_, i) => ({ kind: "text", text: `queued-${i}` }));
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
      users: { u1: { userId: "u1", sessionId: "wx-s1", cwd: dir, silent: false, crossSessionNotify: "inherit", watchedSessions: [] } },
      outbound: { version: 1, peerUserId: "u1", messageCount: 3, queue },
    }), "utf-8");

    const bridge = new WeChatDSHBridge(
      { get: () => undefined, on: () => () => {} },
      { ...defaultConfig(), storageDir: dir, mergeSilenceMs: 0 },
    );
    live.push(bridge);
    const restored = (bridge as unknown as { outboundCache: Array<{ text?: string }> }).outboundCache;
    expect(restored).toHaveLength(150);
    expect(restored[0]?.text).toBe("queued-0");
    expect(restored.at(-1)?.text).toBe("queued-149");
  });
});
