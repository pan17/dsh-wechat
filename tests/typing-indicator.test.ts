/**
 * Typing indicator (iLink sendtyping) — mirrors agent.status:
 *
 *   start:
 *     - agent/inbox/spliced (next-turn) on a WeChat-bound session — works
 *       for BOTH wx-msg- and GUI-typed triggers (the WeChat-bound user is
 *       waiting either way; agent.status flips to "running")
 *
 *   stays on through:
 *     - multiple assistant/message text blocks
 *     - approval/requested cards (agent pauses but is still "running")
 *     - question/requested cards
 *     - tool calls (no special event, but turn hasn't ended)
 *
 *   stops ONLY on:
 *     - turn/end
 *     - agent/error
 *     - bridge.stop()
 *     - TTL safety net (only if the keepalive loop itself stops)
 *
 *   refresh:
 *     - periodic TYPING (status=1) every 10s via setInterval keepalive
 *     - safety timer is refreshed by every keepalive tick (matches openclaw)
 *
 *   negative:
 *     - non-bound sessions do NOT trigger typing
 *     - next-step splices do NOT trigger typing
 *     - sendtyping errors do not break the main flow
 *
 *   ticket caching:
 *     - getconfig is called only on miss / TTL expiry
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendMediaMessage = vi.fn().mockResolvedValue(undefined);
const sendTypingMock = vi.fn().mockResolvedValue(undefined);
const getConfigMock = vi.fn().mockResolvedValue({ typing_ticket: "tk-default" });

vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
  sendMediaMessage: (...args: unknown[]) => sendMediaMessage(...args),
  splitText: (text: string, maxLen: number) =>
    text.length <= maxLen ? [text] : [text.slice(0, maxLen), text.slice(maxLen)],
}));

vi.mock("../src/weixin/api.js", () => ({
  sendTyping: (...args: unknown[]) => sendTypingMock(...args),
  getConfig: (...args: unknown[]) => getConfigMock(...args),
  isSessionTimeoutError: () => false,
  isMessageLimitError: () => false,
  isInvalidRequestError: () => false,
}));

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";
import { TypingStatus } from "../src/weixin/types.js";

function makeMockAgent(id: string) {
  return {
    agent: {
      id,
      status: "idle",
      options: { provider: "deepseek", model: "deepseek-chat" },
      followup: () => {},
      steer: () => {},
      cancel: () => {},
      whenIdle: async () => {},
    },
  };
}

function makeBridge(agent: { agent: unknown }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-type-"));
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
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "bot",
    savedAt: "",
  };
  return bridge;
}

/** Drain microtasks so async sendtyping/sendTextMessage calls flush. */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

/** Calls to sendTypingMock with a stable shape: { userId, status }. */
function typingCalls(): Array<{ userId: string; status: number }> {
  return sendTypingMock.mock.calls.map((call) => {
    const body = (call[0] as { body: { ilink_user_id: string; status: number } }).body;
    return { userId: body.ilink_user_id, status: body.status };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
  sendTypingMock.mockResolvedValue(undefined);
  getConfigMock.mockResolvedValue({ typing_ticket: "tk-default" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("typing indicator: trigger on next-turn splice", () => {
  it("WeChat-bound session + wx-msg- splice sends TYPING (status=1)", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await flush();

    expect(typingCalls()).toContainEqual({ userId: "u1", status: TypingStatus.TYPING });
  });

  it("GUI-typed splice (no wx-msg- prefix) ALSO triggers typing on a WeChat-bound session", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "00000000-0000-4000-8000-000000000000", role: "user" }],
      },
    });
    await flush();

    expect(typingCalls()).toContainEqual({ userId: "u1", status: TypingStatus.TYPING });
  });

  it("next-turn splice with empty inserted still triggers typing", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: { target: "next-turn", start: 0, removedCount: 0, inserted: [] },
    });
    await flush();

    expect(typingCalls()).toContainEqual({ userId: "u1", status: TypingStatus.TYPING });
  });

  it("next-step splice (steer/inject) does NOT trigger typing", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-step",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-internal", role: "user" }],
      },
    });
    await flush();

    expect(typingCalls()).toEqual([]);
  });

  it("an unbound session does NOT trigger typing", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as { handleSessionEvent(s: string, e: unknown): void };

    // No state.ensureUser / update → userForAgent returns undefined.
    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await flush();

    expect(typingCalls()).toEqual([]);
  });

  it("second beginTyping while already active is a no-op (idempotent)", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    // Two consecutive splices — the second one must NOT re-fire beginTyping.
    for (let i = 0; i < 2; i++) {
      anyBridge.handleSessionEvent("wx-s1", {
        type: "agent/inbox/spliced",
        seq: i + 1,
        time: Date.now(),
        data: {
          target: "next-turn",
          start: 0,
          removedCount: 0,
          inserted: [{ id: `wx-msg-${i}`, role: "user" }],
        },
      });
    }
    await flush();

    // Only the initial beginTyping should fire one TYPING. (Keepalive ticks
    // would also be TYPING, but we haven't advanced time yet — so just 1.)
    const typingSends = typingCalls().filter((c) => c.status === TypingStatus.TYPING);
    expect(typingSends).toHaveLength(1);
  });
});

describe("typing indicator: stays on through assistant text", () => {
  it("first assistant/message does NOT cancel typing", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await flush();
    expect(typingCalls().some((c) => c.status === TypingStatus.TYPING)).toBe(true);

    anyBridge.handleSessionEvent("wx-s1", {
      type: "assistant/message",
      seq: 2,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "你好" }] } },
    });
    await flush();

    // Typing persists: no CANCEL sent.
    expect(typingCalls().some((c) => c.status === TypingStatus.CANCEL)).toBe(false);
    // The assistant text still goes to WeChat (independent of typing).
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("multiple assistant/message blocks in the same turn keep typing alive", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await flush();

    for (let i = 0; i < 5; i++) {
      anyBridge.handleSessionEvent("wx-s1", {
        type: "assistant/message",
        seq: 2 + i,
        time: Date.now(),
        data: { turn: 1, step: i + 1, message: { content: [{ type: "text", text: `段${i}` }] } },
      });
    }
    await flush();

    const cancelSends = typingCalls().filter((c) => c.status === TypingStatus.CANCEL);
    expect(cancelSends).toHaveLength(0);
  });
});

describe("typing indicator: stays on through approval/question cards", () => {
  it("approval/requested does NOT cancel typing (agent still 'running')", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      handleMuxFrame(f: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await flush();

    anyBridge.handleMuxFrame({
      type: "server-request",
      rpcId: "rpc-1",
      method: "approval/requested",
      payload: { type: "approval/requested", sessionId: "wx-s1", approvalId: "a1", toolName: "pwsh" },
    });
    await flush();

    expect(typingCalls().some((c) => c.status === TypingStatus.CANCEL)).toBe(false);
  });

  it("question/requested does NOT cancel typing", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      handleMuxFrame(f: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await flush();

    anyBridge.handleMuxFrame({
      type: "server-request",
      rpcId: "rpc-2",
      method: "question/requested",
      payload: {
        type: "question/requested",
        sessionId: "wx-s1",
        questions: [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }] }],
      },
    });
    await flush();

    expect(typingCalls().some((c) => c.status === TypingStatus.CANCEL)).toBe(false);
  });
});

describe("typing indicator: clear on turn/end", () => {
  it("turn/end cancels typing (with or without prior assistant text)", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await flush();

    anyBridge.handleSessionEvent("wx-s1", {
      type: "assistant/message",
      seq: 2,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "已收到" }] } },
    });
    anyBridge.handleSessionEvent("wx-s1", {
      type: "turn/end",
      seq: 3,
      time: Date.now(),
      data: { turn: 1, reason: "success" },
    });
    await flush();

    expect(typingCalls()).toContainEqual({ userId: "u1", status: TypingStatus.CANCEL });
  });

  it("turn/end without any assistant text also cancels typing", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await flush();

    anyBridge.handleSessionEvent("wx-s1", {
      type: "turn/end",
      seq: 2,
      time: Date.now(),
      data: { turn: 1, reason: "stop" },
    });
    await flush();

    expect(typingCalls()).toContainEqual({ userId: "u1", status: TypingStatus.CANCEL });
  });
});

describe("typing indicator: clear on agent error and stop", () => {
  it("agent/error cancels typing", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      handleAgentError(a: string, err: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await flush();

    anyBridge.handleAgentError("wx-s1", new Error("boom"));
    await flush();

    expect(typingCalls()).toContainEqual({ userId: "u1", status: TypingStatus.CANCEL });
  });

  it("bridge.stop() cancels all active typing indicators", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      stop(): Promise<void>;
      token: unknown;
    };
    // Two bound sessions to simulate multiple users.
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });
    anyBridge.state.ensureUser("u2", "C:\\work2");
    anyBridge.state.update("u2", { sessionId: "wx-s2" });
    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw",
      token: "t",
      accountId: "b1",
      userId: "bot",
      savedAt: "",
    };

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-1", role: "user" }],
      },
    });
    anyBridge.handleSessionEvent("wx-s2", {
      type: "agent/inbox/spliced",
      seq: 2,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-2", role: "user" }],
      },
    });
    await flush();

    // Both should have an active TYPING by now.
    const typingSends = typingCalls().filter((c) => c.status === TypingStatus.TYPING);
    expect(typingSends).toHaveLength(2);

    await anyBridge.stop();
    await flush();

    const cancelSends = typingCalls().filter((c) => c.status === TypingStatus.CANCEL);
    expect(cancelSends.map((c) => c.userId).sort()).toEqual(["u1", "u2"]);
  });
});

describe("typing indicator: TTL safety net", () => {
  it("safety timer cancels typing when keepalive stops refreshing", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      typingActive: Map<string, { keepAliveTimer: NodeJS.Timeout }>;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(typingCalls().some((c) => c.status === TypingStatus.TYPING)).toBe(true);
    expect(typingCalls().some((c) => c.status === TypingStatus.CANCEL)).toBe(false);

    // Manually stop the keepalive to simulate the loop having faulted.
    // Without this, advancing time past the safety TTL would also fire
    // the keepalive (which refreshes the safety timer, making this test
    // meaningless).
    const active = anyBridge.typingActive.get("u1");
    if (active) clearInterval(active.keepAliveTimer);

    // Advance past the 2-minute safety TTL. Safety timer fires → CANCEL.
    vi.advanceTimersByTime(2 * 60_000 + 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(typingCalls().some((c) => c.status === TypingStatus.CANCEL)).toBe(true);
  });

  it("safety timer is refreshed by every keepalive tick — never fires under normal operation", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    const cancelBefore = typingCalls().filter((c) => c.status === TypingStatus.CANCEL).length;

    // Advance well past the 2-minute safety TTL. The keepalive interval
    // (10s) fires ~12 times during this window, each one refreshing the
    // safety timer. No CANCEL should ever be emitted.
    vi.advanceTimersByTime(5 * 60_000);
    await Promise.resolve();
    await Promise.resolve();

    const cancelAfter = typingCalls().filter((c) => c.status === TypingStatus.CANCEL).length;
    expect(cancelAfter).toBe(cancelBefore);
  });

  it("turn/end clears the safety timer (no CANCEL after, even after advancing past TTL)", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      typingActive: Map<string, unknown>;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    anyBridge.handleSessionEvent("wx-s1", {
      type: "turn/end",
      seq: 2,
      time: Date.now(),
      data: { turn: 1, reason: "success" },
    });
    await Promise.resolve();
    await Promise.resolve();

    const cancelBefore = typingCalls().filter((c) => c.status === TypingStatus.CANCEL).length;
    expect(cancelBefore).toBe(1);
    // typingActive entry was removed by endTyping; the safety timer reference
    // is gone with it.
    expect(anyBridge.typingActive.has("u1")).toBe(false);

    // Advance well past the safety TTL. Safety timer reference is gone, so
    // no further CANCEL fires.
    vi.advanceTimersByTime(5 * 60_000);
    await Promise.resolve();
    await Promise.resolve();

    const cancelAfter = typingCalls().filter((c) => c.status === TypingStatus.CANCEL).length;
    expect(cancelAfter).toBe(1);
  });
});

describe("typing indicator: periodic keepalive", () => {
  it("TYPING (status=1) is re-sent every ~10s while the turn is running", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: string): unknown };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    // After 1s: only the initial TYPING fired (no keepalive yet at 10s).
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      typingCalls().filter((c) => c.status === TypingStatus.TYPING).length,
    ).toBe(1);

    // After 11s total: 1 initial + 1 keepalive tick = 2 TYPINGs.
    vi.advanceTimersByTime(10_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      typingCalls().filter((c) => c.status === TypingStatus.TYPING).length,
    ).toBe(2);

    // After 31s total: 1 initial + 3 keepalive ticks = 4 TYPINGs.
    vi.advanceTimersByTime(20_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      typingCalls().filter((c) => c.status === TypingStatus.TYPING).length,
    ).toBe(4);
  });

  it("keepalive stops firing after turn/end", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: string): unknown };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    const typingBeforeTurnEnd = typingCalls().filter((c) => c.status === TypingStatus.TYPING).length;

    anyBridge.handleSessionEvent("wx-s1", {
      type: "turn/end",
      seq: 2,
      time: Date.now(),
      data: { turn: 1, reason: "success" },
    });
    await Promise.resolve();
    await Promise.resolve();

    // Advance well past the keepalive interval: no further TYPING should fire.
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();

    const typingAfterTurnEnd = typingCalls().filter((c) => c.status === TypingStatus.TYPING).length;
    expect(typingAfterTurnEnd).toBe(typingBeforeTurnEnd);
    // And exactly one CANCEL was sent.
    expect(
      typingCalls().filter((c) => c.status === TypingStatus.CANCEL),
    ).toHaveLength(1);
  });
});

describe("typing indicator: typing_ticket caching", () => {
  it("getconfig is called only once across multiple status sends within TTL (cache hits)", async () => {
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    // Start → first send → cache miss → getconfig.
    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await flush();
    expect(getConfigMock).toHaveBeenCalledTimes(1);

    // Two more assistant/message events + an approval frame + another
    // splice — none of these trigger endTyping in the new semantics, so the
    // keepalive keeps firing the cached TYPING. Cache hit throughout.
    anyBridge.handleSessionEvent("wx-s1", {
      type: "assistant/message",
      seq: 2,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "完成" }] } },
    });
    await flush();
    expect(getConfigMock).toHaveBeenCalledTimes(1);
  });

  it("getconfig is re-called after the cached ticket expires (TTL=5min)", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(getConfigMock).toHaveBeenCalledTimes(1);

    // Advance past the 5-minute cache TTL.
    vi.advanceTimersByTime(5 * 60_000 + 1);

    // Trigger a fresh next-turn splice: beginTyping → sendTypingStatus →
    // getTypingTicket. Cache is expired, so getconfig must run again.
    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 2,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-def", role: "user" }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(getConfigMock).toHaveBeenCalledTimes(2);
  });
});

describe("typing indicator: error tolerance", () => {
  it("sendtyping failure does not break handleSessionEvent", async () => {
    sendTypingMock.mockRejectedValueOnce(new Error("network"));
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    expect(() => {
      anyBridge.handleSessionEvent("wx-s1", {
        type: "agent/inbox/spliced",
        seq: 1,
        time: Date.now(),
        data: {
          target: "next-turn",
          start: 0,
          removedCount: 0,
          inserted: [{ id: "wx-msg-abc", role: "user" }],
        },
      });
    }).not.toThrow();

    // A subsequent event still flows through (text delivery works).
    anyBridge.handleSessionEvent("wx-s1", {
      type: "assistant/message",
      seq: 2,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "已回复" }] } },
    });
    await flush();

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("getconfig failure yields no typing_ticket → no sendtyping call", async () => {
    getConfigMock.mockRejectedValueOnce(new Error("getconfig down"));
    const bridge = makeBridge(makeMockAgent("wx-s1"));
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-msg-abc", role: "user" }],
      },
    });
    await flush();

    expect(sendTypingMock).not.toHaveBeenCalled();
    // Main flow still works: a follow-up assistant/message can send text.
    anyBridge.handleSessionEvent("wx-s1", {
      type: "assistant/message",
      seq: 2,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "ok" }] } },
    });
    await flush();
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });
});