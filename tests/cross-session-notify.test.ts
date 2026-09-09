/**
 * Cross-session gates — decision cards (full push) vs background task
 * events (turn/end + error), two independent switches:
 *
 *   - `crossSessionNotify` (the /notify toggle) gates decision cards only:
 *     a non-current session's permission/question card is pushed IN FULL
 *     and answerable directly from WeChat.
 *   - `notifyTaskEvents` (config key, default off) gates background task
 *     completion/error notices for non-current sessions.
 *
 * Covers:
 * - default (both off): non-current card → no push (pending kept);
 *   turn/end & error → no notice
 * - cards on / tasks off: card pushed in full with session label;
 *   turn/end & error stay silent
 * - cards off / tasks on: card silent; turn/end & error notify once
 * - dedupe: same turn/end twice within the 30s window notifies once
 * - current-session turn/end never produces a cross notice
 * - per-user overrides are ignored (single-user: global only)
 * - /notify on|off|status commands toggle the card gate only
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

function makeBridgeWithConfig(cards: boolean, tasks: boolean) {
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
  cfg.crossSessionNotify = cards;
  cfg.notifyTaskEvents = tasks;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  // Seed users
  const state: any = (bridge as any).state;
  state.ensureUser("u1", "C:\\work");
  state.update("u1", { sessionId: "sess-A" });
  // Ensure watchedSessions includes sess-B for turn/end recipient resolution.
  state.watchSession("u1", "sess-B");
  (bridge as any).token = { baseUrl: "https://x", token: "t" };
  // Card/task labels use the cheap title path (`ops.readSessionTitle`), not
  // host `sessionQuery.readTitle()`.
  (bridge as any).ops.readSessionTitle = async (id: string) =>
    id === "sess-B" ? "后台任务" : "当前会话";
  return bridge as any;
}

function flushTicks(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r));
}

function approvalFrame(rpcId: string, approvalId: string, sessionId = "sess-B") {
  return {
    type: "server-request",
    rpcId,
    method: "approval/requested",
    payload: { type: "approval/requested", sessionId, approvalId, toolName: "pwsh" },
  };
}

function questionFrame(rpcId: string, sessionId = "sess-B") {
  return {
    type: "server-request",
    rpcId,
    method: "question/requested",
    payload: {
      type: "question/requested",
      sessionId,
      questions: [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }] }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

describe("cross-session gates: default off (both switches)", () => {
  it("non-current turn/end produces no notice when tasks off", async () => {
    const bridge = makeBridgeWithConfig(false, false);
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

  it("non-current error produces no notice when tasks off", async () => {
    const bridge = makeBridgeWithConfig(false, false);
    bridge.handleAgentError("sess-B", new Error("boom"));
    await flushTicks();
    const calls = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(calls.filter((t: string) => t.includes("任务报错"))).toHaveLength(0);
  });

  it("non-current card produces no push when cards off (but pending kept)", async () => {
    const bridge = makeBridgeWithConfig(false, false);
    bridge.handleMuxFrame(approvalFrame("r1", "ap1"));
    await flushTicks();
    expect(sendTextMessage.mock.calls.length).toBe(0);
    expect(bridge.pendingApprovals.get("u1")?.length).toBe(1);
    expect(bridge.pushedCardRpcIds.get("u1")?.has("r1") ?? false).toBe(false);
  });
});

describe("cross-session gates: cards on, tasks off", () => {
  it("non-current question card is pushed in full with the session label", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleMuxFrame(questionFrame("q-rpc"));
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    const card = texts.find((t: string) => t.includes("Continue?"));
    expect(card).toBeDefined();
    expect(card).toContain("❓ 提问");
    expect(card).toContain("📂");
    expect(card).toContain("后台任务");
    expect(bridge.pushedCardRpcIds.get("u1")?.has("q-rpc")).toBe(true);
  });

  it("non-current approval card is pushed in full with the P{n} note", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleMuxFrame(approvalFrame("a-rpc", "ap-1"));
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    const card = texts.find((t: string) => t.includes("pwsh"));
    expect(card).toBeDefined();
    expect(card).toContain("权限");
    expect(card).toContain("来自其他会话");
    expect(card).toContain("P1=1");
  });

  it("turn/end and error stay silent while tasks are off", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    bridge.handleAgentError("sess-B", new Error("boom"));
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(texts.some((t: string) => t.includes("任务已完成"))).toBe(false);
    expect(texts.some((t: string) => t.includes("任务报错"))).toBe(false);
  });
});

describe("cross-session gates: cards off, tasks on", () => {
  it("non-current turn/end produces one notice with workspace/session label", async () => {
    const bridge = makeBridgeWithConfig(false, true);
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

  it("non-current error produces one notice", async () => {
    const bridge = makeBridgeWithConfig(false, true);
    bridge.handleAgentError("sess-B", new Error("boom error"));
    await flushTicks();
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(texts.some((t: string) => t.includes("任务报错") && t.includes("后台任务"))).toBe(true);
  });

  it("non-current card stays silent while cards are off (but pending kept)", async () => {
    const bridge = makeBridgeWithConfig(false, true);
    bridge.handleMuxFrame(questionFrame("q-rpc"));
    await flushTicks();
    expect(sendTextMessage.mock.calls.length).toBe(0);
    expect(bridge.pendingQuestions.get("u1")?.length).toBe(1);
  });
});

describe("cross-session gates: both on", () => {
  it("card push and task notice coexist", async () => {
    const bridge = makeBridgeWithConfig(true, true);
    bridge.handleMuxFrame(questionFrame("q-rpc"));
    bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(texts.some((t: string) => t.includes("Continue?"))).toBe(true);
    expect(texts.some((t: string) => t.includes("任务已完成"))).toBe(true);
  });
});

describe("cross-session task dedupe", () => {
  it("same turn/end twice notifies only once within the 30s window", async () => {
    const bridge = makeBridgeWithConfig(false, true);
    bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    const cross = sendTextMessage.mock.calls.map((c: any) => c[1] as string).filter((t: string) => t.includes("任务已完成"));
    expect(cross).toHaveLength(1);
  });

  it("current session turn/end does not trigger a cross-session notice", async () => {
    const bridge = makeBridgeWithConfig(false, true);
    // sess-A is current for u1
    bridge.handleSessionEvent("sess-A", { type: "turn/end", time: Date.now(), data: {} });
    await flushTicks();
    const cross = sendTextMessage.mock.calls.map((c: any) => c[1] as string).filter((t: string) => t.includes("任务已完成"));
    expect(cross).toHaveLength(0);
  });
});

describe("cross-session gates: per-user override (single-user: global only)", () => {
  it("global cards off + per-user on → still does NOT push (per-user ignored)", async () => {
    const bridge = makeBridgeWithConfig(false, false);
    (bridge as any).state.update("u1", { crossSessionNotify: "on" });
    bridge.handleMuxFrame(questionFrame("q-rpc"));
    await flushTicks();
    expect(sendTextMessage.mock.calls.length).toBe(0);
  });

  it("global cards on + per-user off → still pushes (per-user ignored)", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    (bridge as any).state.update("u1", { crossSessionNotify: "off" });
    bridge.handleMuxFrame(questionFrame("q-rpc"));
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(texts.some((t: string) => t.includes("Continue?"))).toBe(true);
  });
});

describe("/notify command", () => {
  it("parses /notify on|off|status and /notify tasks on|off", async () => {
    const { parseNotifyCommand } = await import("../src/bridge/slash.js");
    expect(parseNotifyCommand("/notify")).toEqual({ kind: "status" });
    expect(parseNotifyCommand("/notify status")).toEqual({ kind: "status" });
    expect(parseNotifyCommand("/notify on")).toEqual({ kind: "on" });
    expect(parseNotifyCommand("/notify off")).toEqual({ kind: "off" });
    expect(parseNotifyCommand("/watch on")).toEqual({ kind: "on" });
    expect(parseNotifyCommand("/notice off")).toEqual({ kind: "off" });
    expect(parseNotifyCommand("/notify tasks on")).toEqual({ kind: "tasks-on" });
    expect(parseNotifyCommand("/notify task off")).toEqual({ kind: "tasks-off" });
  });

  it("/notify on updates only the card gate; status shows both gates", async () => {
    const bridge = makeBridgeWithConfig(false, true);
    const anyBridge: any = bridge;
    await anyBridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "tok",
      item_list: [{ type: 1, text_item: { text: "/notify on" } }],
    });
    expect((anyBridge as any).config.crossSessionNotify).toBe(true);
    expect((anyBridge as any).config.notifyTaskEvents).toBe(true);
    expect(sendTextMessage.mock.calls.some((c: any) => (c[1] as string).includes("已开启"))).toBe(true);
    sendTextMessage.mockClear();
    await anyBridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "tok",
      item_list: [{ type: 1, text_item: { text: "/notify status" } }],
    });
    const statusText = sendTextMessage.mock.calls.map((c: any) => c[1] as string).join("\n");
    expect(statusText).toContain("跨会话决策推送: on");
    expect(statusText).toContain("后台任务完成/报错提醒: on");
  });

  it("/notify on flushes unseen background cards", async () => {
    const bridge = makeBridgeWithConfig(false, false);
    const anyBridge: any = bridge;
    anyBridge.handleMuxFrame(questionFrame("q-rpc"));
    await flushTicks();
    expect(sendTextMessage.mock.calls.length).toBe(0);
    await anyBridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "tok",
      item_list: [{ type: 1, text_item: { text: "/notify on" } }],
    });
    await flushTicks();
    await new Promise((r) => setTimeout(r, 10));
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(texts.some((t: string) => t.includes("Continue?"))).toBe(true);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("q-rpc")).toBe(true);
  });

  it("/notify off leaves the task gate untouched", async () => {
    const bridge = makeBridgeWithConfig(true, true);
    const anyBridge: any = bridge;
    await anyBridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "tok",
      item_list: [{ type: 1, text_item: { text: "/notify off" } }],
    });
    expect((anyBridge as any).config.crossSessionNotify).toBe(false);
    expect((anyBridge as any).config.notifyTaskEvents).toBe(true);
  });

  it("/notify tasks on|off toggles only the task gate", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    const anyBridge: any = bridge;
    await anyBridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "tok",
      item_list: [{ type: 1, text_item: { text: "/notify tasks on" } }],
    });
    expect(anyBridge.config.crossSessionNotify).toBe(true);
    expect(anyBridge.config.notifyTaskEvents).toBe(true);
    await anyBridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "tok",
      item_list: [{ type: 1, text_item: { text: "/notify tasks off" } }],
    });
    expect(anyBridge.config.crossSessionNotify).toBe(true);
    expect(anyBridge.config.notifyTaskEvents).toBe(false);
  });
});

function wechatText(text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

describe("inbound intercept follows the decision gate", () => {
  it("gate off: a hidden background question does not swallow current-session chat", async () => {
    const bridge = makeBridgeWithConfig(false, false);
    bridge.handleMuxFrame(questionFrame("q-rpc"));
    const card = bridge.pendingQuestions.get("u1")![0]!;
    let answered = false;
    card.settleWechat = () => {
      answered = true;
    };
    sendTextMessage.mockClear();
    await bridge.handleMessage(wechatText("好的继续"));
    expect(answered).toBe(false);
    expect(bridge.pendingQuestions.get("u1")?.length).toBe(1);
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(texts.some((t: string) => t.includes("提问卡待处理"))).toBe(false);
  });

  it("gate on: a lone background question does not swallow a bare reply", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleMuxFrame(questionFrame("q-rpc"));
    const card = bridge.pendingQuestions.get("u1")![0]!;
    let answered = false;
    card.settleWechat = () => {
      answered = true;
    };
    await bridge.handleMessage(wechatText("1"));
    expect(answered).toBe(false);
    expect(bridge.pendingQuestions.get("u1")?.length).toBe(1);
  });

  it("gate on: P1= custom text answers a background plan card even if a current approval is pending", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleMuxFrame(questionFrame("q-plan", "sess-B"));
    bridge.handleMuxFrame(approvalFrame("a-cur", "ap-cur", "sess-A"));
    const q = bridge.pendingQuestions.get("u1")![0]!;
    const answers: unknown[] = [];
    q.settleWechat = (a: unknown) => answers.push(a);
    const ap = bridge.pendingApprovals.get("u1")![0]!;
    let approvalHit = false;
    ap.settleWechat = () => {
      approvalHit = true;
    };
    await bridge.handleMessage(wechatText("P1=我的意思不是退出plan"));
    expect(approvalHit).toBe(false);
    expect(answers).toHaveLength(1);
    const item = (answers[0] as { answers: Array<{ custom?: string; selected: string[] }> }).answers[0]!;
    expect(item.custom ?? item.selected.join("")).toContain("我的意思不是退出plan");
    expect(bridge.pendingQuestions.get("u1") ?? []).toHaveLength(0);
    expect(bridge.pendingApprovals.get("u1")?.length).toBe(1);
  });

  it("gate on: P1= answers a background question without switching", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleMuxFrame(questionFrame("q-rpc"));
    const card = bridge.pendingQuestions.get("u1")![0]!;
    const answers: unknown[] = [];
    card.settleWechat = (a: unknown) => answers.push(a);
    await bridge.handleMessage(wechatText("P1=1"));
    expect(answers).toHaveLength(1);
    expect(bridge.pendingQuestions.get("u1") ?? []).toHaveLength(0);
  });

  it("gate on: P1=/rq closes that question card", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleMuxFrame(questionFrame("q-rpc"));
    const card = bridge.pendingQuestions.get("u1")![0]!;
    const cancelled: unknown[] = [];
    card.cancelWechat = (r: unknown) => cancelled.push(r);
    await bridge.handleMessage(wechatText("P1=/rq"));
    expect(cancelled).toHaveLength(1);
    expect(bridge.pendingQuestions.get("u1") ?? []).toHaveLength(0);
    const texts = sendTextMessage.mock.calls.map((c: any) => c[1] as string);
    expect(texts.some((t: string) => t.includes("已关闭提问卡 P1"))).toBe(true);
  });

  it("gate on: bare 1 answers only the current session's approval", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleMuxFrame(approvalFrame("a-cur", "ap-cur", "sess-A"));
    bridge.handleMuxFrame(approvalFrame("a-bg", "ap-bg", "sess-B"));
    const cur = bridge.pendingApprovals.get("u1")!.find((c: any) => c.rpcId === "a-cur")!;
    const bg = bridge.pendingApprovals.get("u1")!.find((c: any) => c.rpcId === "a-bg")!;
    let currentAnswered = false;
    let bgAnswered = false;
    cur.settleWechat = () => {
      currentAnswered = true;
    };
    bg.settleWechat = () => {
      bgAnswered = true;
    };
    await bridge.handleMessage(wechatText("1"));
    expect(currentAnswered).toBe(true);
    expect(bgAnswered).toBe(false);
    expect(bridge.pendingApprovals.get("u1")?.map((c: any) => c.rpcId)).toEqual(["a-bg"]);
  });

  it("gate on: P1=/rq closes that approval card", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleMuxFrame(approvalFrame("a-bg", "ap-bg"));
    const card = bridge.pendingApprovals.get("u1")![0]!;
    const outcomes: string[] = [];
    card.settleWechat = (o: string) => outcomes.push(o);
    await bridge.handleMessage(wechatText("P1=/rq"));
    expect(outcomes).toEqual(["rejected"]);
    expect(bridge.pendingApprovals.get("u1") ?? []).toHaveLength(0);
  });

  it("/status splits current vs cross-session pending cards", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleMuxFrame(questionFrame("q-cur", "sess-A"));
    bridge.handleMuxFrame(approvalFrame("a-bg", "ap-bg", "sess-B"));
    sendTextMessage.mockClear();
    await bridge.handleMessage(wechatText("/status"));
    const statusText = sendTextMessage.mock.calls.map((c: any) => c[1] as string).join("\n");
    expect(statusText).toContain("🔴 • 待处理(当前): 1 张提问卡");
    expect(statusText).toContain("🔴 • 待处理(跨会话): 1 张权限卡（用 P{n}= 回复）");
  });

  it("/rq closes only current-session cards, not background ones", async () => {
    const bridge = makeBridgeWithConfig(true, false);
    bridge.handleMuxFrame(questionFrame("q-cur", "sess-A"));
    bridge.handleMuxFrame(approvalFrame("a-bg", "ap-bg", "sess-B"));
    const cur = bridge.pendingQuestions.get("u1")![0]!;
    const cancelled: unknown[] = [];
    cur.cancelWechat = (r: unknown) => cancelled.push(r);
    await bridge.handleMessage(wechatText("/rq"));
    expect(cancelled).toHaveLength(1);
    expect(bridge.pendingQuestions.get("u1") ?? []).toHaveLength(0);
    expect(bridge.pendingApprovals.get("u1")?.length).toBe(1);
  });

  it("gate off: /rq does not reject a hidden background approval", async () => {
    const bridge = makeBridgeWithConfig(false, false);
    bridge.handleMuxFrame(approvalFrame("a-bg", "ap-bg"));
    expect(bridge.pendingApprovals.get("u1")?.length).toBe(1);
    await bridge.handleMessage(wechatText("/rq"));
    expect(bridge.pendingApprovals.get("u1")?.length).toBe(1);
  });
});
