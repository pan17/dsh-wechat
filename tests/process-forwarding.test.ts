import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/weixin/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/weixin/send.js")>();
  return { ...actual, sendTextMessage: (...args: unknown[]) => sendTextMessage(...args), sendMediaMessage: vi.fn() };
});
vi.mock("../src/weixin/api.js", () => ({
  sendTyping: async () => {}, getConfig: async () => ({ typing_ticket: "tk" }),
  isSessionTimeoutError: () => false, isMessageLimitError: () => false, isInvalidRequestError: () => false,
}));
vi.mock("../src/weixin/auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/weixin/auth.js")>(), login: () => new Promise(() => {}),
}));

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";

let bridge: WeChatDSHBridge;
let dir: string;
let seq: number;
/** The real runtime allocates a NEW revision for every emitted frame. */
let rev: number;
const nextRev = () => ++rev;
type Internals = {
  token: unknown; config: { silent: boolean; textChunkLimit: number };
  state: { ensureUser(u: string, cwd: string): unknown; update(u: string, patch: unknown): void };
  outboundSerial: Promise<void>; wechatMsgCount: number; outboundCache: Array<{ kind: string; text?: string }>;
  sendReply(u: string, text: string): Promise<void>; flushPending(u: string, opts?: { silent: boolean }): Promise<void>;
  processes: Map<string, unknown>; silentBuffers: Map<string, string[]>;
};
const b = () => bridge as unknown as Internals;
const emit = (type: string, data: unknown, session = "s1") => bridge.handleSessionEvent(session, { type, seq: seq++, data });
const assistant = (...content: Array<{ type: string; text?: string; [key: string]: unknown }>) => emit("assistant/message", { turn: 1, step: 1, message: { content } });
const call = (id = "c1", name = "read") => emit("tool/call", { turn: 1, step: 1, callId: id, name, arguments: '{"file_path":"src/foo_bar.ts"}' });
const result = (id = "c1", text = "读取完成") => emit("tool/result", { turn: 1, step: 1, message: { toolCallId: id, content: [{ type: "text", text }] } });
const texts = () => sendTextMessage.mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  vi.clearAllMocks(); sendTextMessage.mockReset().mockResolvedValue(undefined);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-process-"));
  bridge = new WeChatDSHBridge({ get: () => undefined, on: () => () => {} }, { ...defaultConfig(), storageDir: dir });
  b().state.ensureUser("u1", "C:\\work"); b().state.update("u1", { sessionId: "s1" });
  b().token = { baseUrl: "https://gw", token: "t" }; seq = 0; rev = 0;
});
afterEach(async () => { await bridge.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

const streamStart = (attemptId = "a1", step = 1) => bridge.handleAssistantStream("s1", { type: "start", attemptId, revision: nextRev(), turn: 1, step });
const streamChunk = (index: number, chunk: { type: string; index?: number; text?: string; block?: { type: string; text?: string } }, attemptId = "a1") =>
  bridge.handleAssistantStream("s1", { type: "chunk", attemptId, revision: nextRev(), index, time: Date.now(), chunk });
const streamEnd = (index: number, outcome: { kind: "committed"; eventType: "assistant/message" | "assistant/attempt"; seq: number } | { kind: "abandoned" }, attemptId = "a1") =>
  bridge.handleAssistantStream("s1", { type: "end", attemptId, revision: nextRev(), index, outcome });

describe("grouped process delivery", () => {
  it("flushes on the first prose chunk when every frame carries a new revision", async () => {
    // Regression: the runtime allocates a fresh revision per frame, so an
    // equality check against the start frame's revision dropped every chunk
    // and the process only appeared after the durable commit.
    assistant({ type: "reasoning", text: "已完成分析" }); call(); result();
    bridge.handleAssistantStream("s1", { type: "start", attemptId: "r1", revision: 7, turn: 1, step: 2 });
    bridge.handleAssistantStream("s1", { type: "chunk", attemptId: "r1", revision: 8, index: 0, time: Date.now(), chunk: { type: "text-delta", index: 0, text: "正" } });
    await b().outboundSerial;
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain("思考");
    bridge.handleAssistantStream("s1", { type: "chunk", attemptId: "r1", revision: 9, index: 1, time: Date.now(), chunk: { type: "text-delta", index: 0, text: "文" } });
    await b().outboundSerial; expect(texts()).toHaveLength(1);
  });

  it("ignores frames whose revision is not newer and duplicate start frames", async () => {
    assistant({ type: "reasoning", text: "只发一次" });
    bridge.handleAssistantStream("s1", { type: "start", attemptId: "r2", revision: 5, turn: 1, step: 1 });
    bridge.handleAssistantStream("s1", { type: "start", attemptId: "r2", revision: 5, turn: 1, step: 1 });
    const chunk = { type: "chunk", attemptId: "r2", revision: 6, index: 0, time: Date.now(), chunk: { type: "text-delta", index: 0, text: "正文" } } as const;
    bridge.handleAssistantStream("s1", chunk);
    bridge.handleAssistantStream("s1", chunk);
    bridge.handleAssistantStream("s1", { type: "chunk", attemptId: "r2", revision: 4, index: 1, time: Date.now(), chunk: { type: "text-delta", index: 0, text: "迟到" } });
    await b().outboundSerial;
    expect(texts()).toHaveLength(1); expect(texts()[0]).toContain("只发一次");
  });

  it("sends process on the first prose chunk while the next response is still incomplete", async () => {
    assistant({ type: "text", text: "先检查" });
    assistant({ type: "reasoning", text: "第一步\n隐藏正文" }); call(); result();
    streamStart("next", 2);
    streamChunk(0, { type: "reasoning-delta", index: 0, text: "**准备结论**\n隐藏推理" }, "next");
    streamChunk(1, { type: "text-delta", index: 1, text: "   " }, "next");
    await b().outboundSerial; expect(texts()).toEqual(["先检查"]);
    streamChunk(2, { type: "text-delta", index: 1, text: "结" }, "next");
    await b().outboundSerial;
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain("思考 · 第一步");
    expect(texts()[1]).toContain("思考 · 准备结论");
    expect(texts()[1]).toContain("读取 · src/foo_bar.ts");
    expect(texts()[1]).not.toContain("隐藏");
    streamChunk(3, { type: "text-delta", index: 1, text: "论还没完" }, "next");
    await b().outboundSerial; expect(texts()).toHaveLength(2);
    emit("assistant/message", { turn: 1, step: 2, message: { content: [
      { type: "reasoning", text: "**准备结论**\n隐藏推理" }, { type: "text", text: "结论还没完" },
    ] } });
    streamEnd(4, { kind: "committed", eventType: "assistant/message", seq: seq - 1 }, "next");
    await b().outboundSerial;
    expect(texts()).toHaveLength(3); expect(texts()[2]).toBe("结论还没完");
  });

  it("handles committed end before listener delivery without repeating streamed reasoning", async () => {
    streamStart(); streamChunk(0, { type: "reasoning-delta", index: 0, text: "摘要\n正文" });
    streamChunk(1, { type: "text-delta", index: 1, text: "开始" }); await b().outboundSerial;
    streamEnd(2, { kind: "committed", eventType: "assistant/message", seq });
    assistant({ type: "reasoning", text: "摘要\n正文" }, { type: "text", text: "开始结束" });
    await b().outboundSerial; expect(texts()).toHaveLength(2); expect(texts()[1]).toBe("开始结束");
  });

  it("discards abandoned attempt reasoning and ignores its late frames", async () => {
    streamStart("old"); streamChunk(0, { type: "reasoning-delta", index: 0, text: "失败尝试" }, "old");
    streamEnd(1, { kind: "abandoned" }, "old");
    streamStart("new"); streamChunk(2, { type: "text-delta", index: 1, text: "迟到" }, "old");
    streamChunk(0, { type: "reasoning-delta", index: 0, text: "有效思考" }, "new");
    streamChunk(1, { type: "text-delta", index: 1, text: "正文" }, "new"); await b().outboundSerial;
    expect(texts()).toHaveLength(1); expect(texts()[0]).toContain("有效思考"); expect(texts()[0]).not.toContain("失败尝试");
  });

  it("ignores duplicate chunks and clears stream state when silent mode changes", async () => {
    streamStart(); streamChunk(0, { type: "reasoning-delta", index: 0, text: "不补发" });
    await bridge.updateConfig({ silent: true }); await bridge.updateConfig({ silent: false });
    streamChunk(1, { type: "text-delta", index: 1, text: "正文" }); await b().outboundSerial; expect(texts()).toEqual([]);
    streamStart("new"); streamChunk(0, { type: "reasoning-delta", index: 0, text: "正常" }, "new");
    streamChunk(1, { type: "text-delta", index: 1, text: "正文" }, "new");
    streamChunk(1, { type: "text-delta", index: 1, text: "正文" }, "new"); await b().outboundSerial;
    expect(texts()).toHaveLength(1);
  });

  it("matches desktop prose → grouped process → prose across multiple steps", async () => {
    assistant({ type: "text", text: "先检查" });
    assistant({ type: "reasoning", text: "检查输入" }, { type: "tool-call", id: "c1", name: "read" });
    call(); result();
    assistant({ type: "reasoning", text: "继续检查" }); call("c2", "grep"); result("c2", "找到结果");
    await b().outboundSerial;
    expect(texts()).toEqual(["先检查"]);
    assistant({ type: "text", text: "检查结束" });
    emit("turn/end", { turn: 1, reason: { kind: "completed" } });
    await b().outboundSerial;
    expect(texts()).toHaveLength(3);
    expect(texts()[1]).toContain("思考 ·");
    expect(texts()[1]).toContain("检查输入");
    expect(texts()[1]).toContain("读取 · src/foo_bar.ts");
    expect(texts()[1]).toContain("搜索文件内容 · src/foo_bar.ts");
    expect(texts()[1]).not.toContain("读取完成");
    expect(texts()[1]).not.toContain("找到结果");
    expect(texts()[2]).toBe("检查结束");
    expect(b().processes.size).toBe(0);
  });

  it("flushes a process-only turn at end and ignores failed attempts", async () => {
    emit("assistant/attempt", { stream: [{ type: "reasoning-chunks", texts: ["不应发送"] }] });
    assistant({ type: "reasoning", text: "仅有思考" }); call(); result();
    await b().outboundSerial; expect(texts()).toEqual([]);
    emit("turn/end", { turn: 1 }); await b().outboundSerial;
    expect(texts()).toHaveLength(1); expect(texts()[0]).toContain("仅有思考");
    expect(texts()[0]).not.toContain("不应发送");
  });

  it("silent mode sends only final prose, and toggling never revives hidden process", async () => {
    await bridge.updateConfig({ silent: true });
    assistant({ type: "reasoning", text: "隐藏思考" }, { type: "text", text: "中间正文" }); call(); result();
    assistant({ type: "text", text: "最终正文" }); emit("turn/end", { turn: 1 }); await b().outboundSerial;
    expect(texts()).toEqual(["最终正文"]);
    assistant({ type: "text", text: "不补发正文" });
    await bridge.updateConfig({ silent: false });
    emit("turn/end", { turn: 2 }); await b().outboundSerial;
    expect(texts()).toEqual(["最终正文"]);
    assistant({ type: "reasoning", text: "开启静默前暂存" });
    await bridge.updateConfig({ silent: true }); await bridge.updateConfig({ silent: false });
    emit("turn/end", { turn: 3 }); await b().outboundSerial;
    expect(texts()).toEqual(["最终正文"]);
  });

  it("deduplicates committed events and preserves within-message block order", async () => {
    const event = { type: "assistant/message", seq: 22, data: { message: { content: [
      { type: "reasoning", text: "前思考" }, { type: "text", text: "正文一" },
      { type: "reasoning", text: "后思考" }, { type: "text", text: "正文二" },
    ] } } };
    bridge.handleSessionEvent("s1", event); bridge.handleSessionEvent("s1", event);
    await b().outboundSerial;
    expect(texts()).toHaveLength(4);
    expect(texts()[0]).toContain("前思考"); expect(texts()[1]).toBe("正文一");
    expect(texts()[2]).toContain("后思考"); expect(texts()[3]).toBe("正文二");
  });

  it("flushes existing process before a native question card without blocking it", async () => {
    assistant({ type: "reasoning", text: "准备提问" }); call("ask", "ask_user_question");
    let finishGui!: (answer: { answers: Array<{ id: string; selected: string[] }> }) => void;
    const gui = new Promise<{ answers: Array<{ id: string; selected: string[] }> }>((resolve) => { finishGui = resolve; });
    const pending = bridge.answerQuestionRequest({ agent: { id: "s1" }, questions: [{ id: "q", question: "选择方案?", options: [{ label: "A" }] }] }, () => gui);
    await new Promise((resolve) => setImmediate(resolve)); await b().outboundSerial;
    expect(texts()[0]).toContain("思考 ·"); expect(texts()[0]).toContain("提问 ·");
    expect(texts()[1]).toContain("选择方案?");
    finishGui({ answers: [{ id: "q", selected: ["A"] }] });
    await pending; await b().outboundSerial;
  });

  it("rate limiting parks the whole group before prose and /next flushes in order", async () => {
    b().wechatMsgCount = 10;
    assistant({ type: "reasoning", text: "分析" }); call(); result(); assistant({ type: "text", text: "最终回复" });
    await b().outboundSerial;
    expect(sendTextMessage).not.toHaveBeenCalled(); expect(b().outboundCache).toHaveLength(2);
    expect(b().outboundCache[0]!.text).toContain("思考 ·"); expect(b().outboundCache[1]!.text).toBe("最终回复");
    b().wechatMsgCount = 0; await b().flushPending("u1", { silent: true });
    expect(texts()[0]).toContain("思考 ·"); expect(texts()[1]).toBe("最终回复");
  });

  it("failed delivery queues later prose instead of overtaking the group", async () => {
    sendTextMessage.mockRejectedValueOnce(new Error("network"));
    assistant({ type: "reasoning", text: "分析" }); assistant({ type: "text", text: "最终回复" }); await b().outboundSerial;
    expect(b().outboundCache).toHaveLength(2);
    expect(texts()).not.toContain("最终回复");
    await b().flushPending("u1", { silent: true });
    expect(texts().slice(-2)[0]).toContain("思考 ·"); expect(texts().at(-1)).toBe("最终回复");
  });

  it("keeps prose segments together before a later reply", async () => {
    b().config.textChunkLimit = 20;
    const first = b().sendReply("u1", "a".repeat(45)); const second = b().sendReply("u1", "later");
    await Promise.all([first, second]); expect(texts().at(-1)).toBe("later");
    expect(texts().slice(0, -1).join("")).toBe("a".repeat(45));
  });

  it("does not retain offline/unbound process and clears output on disposal/error", async () => {
    b().token = null; assistant({ type: "reasoning", text: "离线" }); call(); expect(b().processes.size).toBe(0);
    b().token = { baseUrl: "https://gw", token: "t" };
    emit("assistant/message", { message: { content: [{ type: "reasoning", text: "其它会话" }] } }, "s2");
    expect(b().processes.size).toBe(0);
    assistant({ type: "reasoning", text: "应清理" }); bridge.clearSessionOutput("s1");
    emit("turn/end", {}); await b().outboundSerial; expect(texts()).toEqual([]);
    assistant({ type: "reasoning", text: "报错前过程" }); bridge.handleAgentError("s1", "bad"); await b().outboundSerial;
    expect(texts()[0]).toContain("报错前过程"); expect(texts()[1]).toContain("Agent 出错");
    expect(b().processes.size).toBe(0);
  });

  it("keeps an unfinished group when saving unchanged settings", async () => {
    assistant({ type: "reasoning", text: "保存前的过程" });
    await bridge.updateConfig({ silent: false });
    assistant({ type: "text", text: "正文" }); await b().outboundSerial;
    expect(texts()[0]).toContain("保存前的过程"); expect(texts()[1]).toBe("正文");
  });

  it("fits a long group in one message and reports omissions", async () => {
    b().config.textChunkLimit = 1000;
    for (let i = 0; i < 20; i++) assistant({ type: "reasoning", text: "长思考".repeat(300) });
    assistant({ type: "text", text: "结束" }); await b().outboundSerial;
    expect(texts()).toHaveLength(2); expect(texts()[0]!.length).toBeLessThanOrEqual(1000);
    expect(texts()[0]).toContain("已省略"); expect(texts()[1]).toBe("结束");
  });

  it("clears process when switching workspaces and ignores the old session", async () => {
    assistant({ type: "reasoning", text: "旧会话过程" }); call();
    const internals = bridge as unknown as { state: { getUser(u: string): unknown }; switchUserWorkspace(u: unknown, cwd: string): Promise<string> };
    await internals.switchUserWorkspace(internals.state.getUser("u1"), "C:\\other");
    result(); emit("turn/end", {}); await b().outboundSerial;
    expect(texts()).toEqual([]); expect(b().processes.size).toBe(0);
  });

  it("drops queued batches and unfinished groups on logout even after same-user relogin", async () => {
    const queued = b().sendReply("u1", "旧正文");
    assistant({ type: "reasoning", text: "旧思考" });
    await bridge.logout();
    b().state.ensureUser("u1", "C:\\work"); b().state.update("u1", { sessionId: "s1" });
    b().token = { baseUrl: "https://gw", token: "new" };
    await queued; emit("turn/end", {}); await b().outboundSerial;
    expect(texts()).toEqual([]); expect(b().processes.size).toBe(0);
  });
});
