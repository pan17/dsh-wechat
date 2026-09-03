/**
 * Cross-session notifications — decision cards follow `crossSessionNotify`
 * (full-card push, directly answerable); background turn/end + error notices
 * follow the independent `notifyTaskEvents` gate (default off).
 *
 * Covers:
 * - default off: non-current turn/end & error & card produce no notification
 * - gates on: cards push in full; turn/end + error notify once with label
 * - dedupe: same turn/end twice in same window notifies once (30s window)
 * - per-user on/off overrides (single-user: global only)
 * - /notify on|off|status commands (decision gate; /tasks gate is separate)
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

function makeBridgeWithConfig(crossSessionNotify: boolean, notifyTaskEvents = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-cross-"));
  const ctx: any = {
    get: (name: string) => {
      if (name === "workspaceRegistry") {
        return {
          list: () => [
            { path: "C:\\work", title: "work", sessionIds: ["sess-B"], createdAt: "", id: "ws1" },
          ],
          archivedSessionIds: [],
        };
      }
      if (name === "sessionQuery") {
        return {
          listSessions: async () => [
            { header: { id: "sess-B", cwd: "C:\\work", createdAt: Date.now() }, live: true, persisted: true },
            { header: { id: "sess-A", cwd: "C:\\work", createdAt: Date.now() }, live: true, persisted: true },
          ],
          readTitle: async (id: string) => ({ title: id === "sess-B" ? "后台任务" : "当前会话" }),
          listEvents: async () => [],
        };
      }
      return undefined;
    },
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  cfg.crossSessionNotify = crossSessionNotify;
  cfg.notifyTaskEvents = notifyTaskEvents;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  // Seed users
  const state: any = (bridge as any).state;
  state.ensureUser("u1", "C:\\work");
  state.update("u1", { sessionId: "sess-A" });
  // Ensure watchedSessions includes sess-B for history test
  state.watchSession("u1", "sess-B");
  (bridge as any).token = { baseUrl: "https://x", token: "t" };
  return bridge as any;
}

function flushTicks(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

describe("cross-session notify: default off", () => {
  it("non-current turn/end produces no notification when off", async () => {
    const bridge = makeBridgeWithConfig(false);
    bridge.handleSessionEvent("sess-B", {
      type: "assistant/message",
      time: Date.now(),
      data: { message: { content: [{ type: "text", text: "hello from B" }] } },
    });
    bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    const calls = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    const cross = calls.filter((t: string) => t.includes("任务已完成"));
    expect(cross).toHaveLength(0);
  });

  it("non-current error produces no notification when off", async () => {
    const bridge = makeBridgeWithConfig(false);
    bridge.handleAgentError("sess-B", new Error("boom"));
    await flushTicks();
    const calls = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(calls.filter((t: string) => t.includes("任务报错"))).toHaveLength(0);
  });

  it("non-current card produces no notification when off (but pending kept)", async () => {
    const bridge = makeBridgeWithConfig(false);
    bridge.handleMuxFrame({
      type: "server-request",
      rpcId: "r1",
      method: "approval/requested",
      payload: { type: "approval/requested", sessionId: "sess-B", approvalId: "ap1", toolName: "pwsh" },
    });
    await flushTicks();
    expect(sendTextMessage.mock.calls.length).toBe(0);
    expect(bridge.pendingApprovals.get("u1")?.length).toBe(1);
  });
});

describe("cross-session notify: decision gate on, task gate off", () => {
  it("non-current turn/end produces no completion notice while notifyTaskEvents is off", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleSessionEvent("sess-B", {
      type: "assistant/message",
      time: Date.now(),
      data: { message: { content: [{ type: "text", text: "result preview text" }] } },
    });
    bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    const cross = texts.filter((t: string) => t.includes("任务已完成"));
    expect(cross).toHaveLength(0);
  });

  it("non-current error produces no notice while notifyTaskEvents is off", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleAgentError("sess-B", new Error("boom error"));
    await flushTicks();
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(texts.some((t: string) => t.includes("任务报错"))).toBe(false);
  });

  it("non-current card pushes the FULL card when the decision gate is on", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleMuxFrame({
      type: "server-request",
      rpcId: "r2",
      method: "question/requested",
      payload: {
        type: "question/requested",
        sessionId: "sess-B",
        questions: [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }] }],
      },
    });
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(texts.some((t: string) => t.includes("Continue?"))).toBe(true);
    expect(texts.some((t: string) => t.includes("📂"))).toBe(true);
  });
});

describe("cross-session notify: both gates on", () => {
  it("non-current turn/end produces one notification with workspace/session label", async () => {
    const bridge = makeBridgeWithConfig(true, true);
    bridge.handleSessionEvent("sess-B", {
      type: "assistant/message",
      time: Date.now(),
      data: { message: { content: [{ type: "text", text: "result preview text" }] } },
    });
    bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    const cross = texts.filter((t: string) => t.includes("任务已完成"));
    expect(cross).toHaveLength(1);
    expect(cross[0]).toContain("📂");
    expect(cross[0]).toContain("后台任务");
    expect(cross[0]).toContain("/session switch");
  });

  it("non-current error produces one notification", async () => {
    const bridge = makeBridgeWithConfig(true, true);
    bridge.handleAgentError("sess-B", new Error("boom error"));
    await flushTicks();
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(texts.some((t: string) => t.includes("任务报错") && t.includes("后台任务"))).toBe(true);
  });

  it("dedup: same turn/end twice notifies only once within 30s window", async () => {
    const bridge = makeBridgeWithConfig(true, true);
    bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    const cross = sendTextMessage.mock.calls.map((c: any) => c[1] as string).filter((t: string) => t.includes("任务已完成"));
    expect(cross).toHaveLength(1);
  });

  it("current session turn/end does not trigger cross-session notification", async () => {
    const bridge = makeBridgeWithConfig(true, true);
    // sess-A is current for u1
    bridge.handleSessionEvent("sess-A", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    const cross = sendTextMessage.mock.calls.map((c: any) => c[1] as string).filter((t: string) => t.includes("任务已完成"));
    expect(cross).toHaveLength(0);
  });
});

describe("cross-session notify: per-user override (single-user: global only)", () => {
  it("global off + per-user on → still does NOT notify (per-user ignored)", async () => {
    const bridge = makeBridgeWithConfig(false, true);
    (bridge as any).state.update("u1", { crossSessionNotify: "on" });
    bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    expect(sendTextMessage.mock.calls.some((c: any) => (c[1] as string).includes("任务已完成"))).toBe(false);
  });

  it("global on + per-user off → still notifies (per-user ignored)", async () => {
    const bridge = makeBridgeWithConfig(true, true);
    (bridge as any).state.update("u1", { crossSessionNotify: "off" });
    bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    expect(sendTextMessage.mock.calls.some((c: any) => (c[1] as string).includes("任务已完成"))).toBe(true);
  });
});

describe("/notify command", () => {
  it("parses /notify on|off|status", async () => {
    const { parseNotifyCommand } = await import("../src/bridge/slash.js");
    expect(parseNotifyCommand("/notify")).toEqual({ kind: "status" });
    expect(parseNotifyCommand("/notify status")).toEqual({ kind: "status" });
    expect(parseNotifyCommand("/notify on")).toEqual({ kind: "on" });
    expect(parseNotifyCommand("/notify off")).toEqual({ kind: "off" });
    expect(parseNotifyCommand("/watch on")).toEqual({ kind: "on" });
    expect(parseNotifyCommand("/notice off")).toEqual({ kind: "off" });
  });

  it("/notify on/off updates global and replies (single-user)", async () => {
    const bridge = makeBridgeWithConfig(false);
    const anyBridge: any = bridge;
    await anyBridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "tok",
      item_list: [{ type: 1, text_item: { text: "/notify on" } }],
    });
    expect((anyBridge as any).config.crossSessionNotify).toBe(true);
    expect(sendTextMessage.mock.calls.some((c: any) => (c[1] as string).includes("已开启"))).toBe(true);
    sendTextMessage.mockClear();
    await anyBridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "tok",
      item_list: [{ type: 1, text_item: { text: "/notify status" } }],
    });
    expect(sendTextMessage.mock.calls.some((c: any) => (c[1] as string).includes("跨会话决策推送"))).toBe(true);
    expect(sendTextMessage.mock.calls.some((c: any) => (c[1] as string).includes("后台任务完成/报错提醒"))).toBe(true);
  });
});
