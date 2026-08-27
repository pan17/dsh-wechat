/**
 * `/history` per-entry truncation:
 *   - Non-last entries ≤ 800 chars pass through unchanged
 *   - Non-last entries > 800 chars are truncated to 800 chars + "…"
 *   - The most recent assistant message is exempt from truncation —
 *     the reader wants to read the latest reply end-to-end
 *   - WeChat chunking (splitText / textChunkLimit) still applies for long totals
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
  getConfig: () => Promise.resolve({ typing_ticket: "tk" }),
  isSessionTimeoutError: () => false,
}));

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";

interface AgentLike {
  session?: { events?: Array<{ type: string; time?: number; data?: unknown }> };
}

function makeBridge(events: Array<{ type: string; time?: number; data?: unknown }>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-hist-"));
  const agent: AgentLike = { session: { events } };
  const agentsService = {
    create: async () => undefined,
    resume: async () => undefined,
    get: (id: string) => (id === "wx-1" ? (agent as never) : undefined),
    list: () => [agent as never],
  };
  const ctx = {
    get: (name: string) => (name === "agents" ? agentsService : undefined),
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  (bridge as unknown as { token: unknown }).token = { baseUrl: "https://x", token: "t" };
  const state = (bridge as unknown as { state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void } }).state;
  state.ensureUser("u1", "C:\\work");
  state.update("u1", { sessionId: "wx-1" });
  return bridge;
}

function assistantEventWithText(text: string, time = Date.now()) {
  return {
    type: "assistant/message",
    time,
    data: { turn: 1, step: 1, message: { content: [{ type: "text", text }] } },
  };
}

function userEventWithText(text: string, time = Date.now()) {
  return {
    type: "user/message",
    time,
    data: { message: { content: [{ type: "text", text }] } },
  };
}

async function runHistory(bridge: WeChatDSHBridge): Promise<string[]> {
  sendTextMessage.mockClear();
  await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage({
    message_type: 1,
    from_user_id: "u1",
    context_token: "ctx",
    item_list: [{ type: 1, text_item: { text: "/history" } }],
  });
  return sendTextMessage.mock.calls.map((c) => String(c[1]));
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

describe("/history per-entry truncation", () => {
  it("passes short entries through unchanged", async () => {
    const bridge = makeBridge([assistantEventWithText("短回复，不到 800 字。")]);
    const texts = await runHistory(bridge);
    expect(texts.join("\n")).toContain("短回复，不到 800 字。");
    expect(texts.join("\n")).not.toContain("…");
  });

  it("truncates non-last entries > 800 chars to 800 + …", async () => {
    // Two assistant events so the long one is NOT the latest — must truncate.
    const long = "x".repeat(1500);
    const bridge = makeBridge([
      assistantEventWithText(long, 1000),
      assistantEventWithText("最新回复，简短。", 2000),
    ]);
    const texts = await runHistory(bridge);
    const text = texts.join("\n");
    // The earlier (long) entry's body line ends at a newline.
    const lines = text.split("\n");
    const truncatedLine = lines.find((l) => l.includes("助手: ") && l.includes("…"));
    expect(truncatedLine).toBeDefined();
    // body shape: "1. [时间] 助手: <truncated>"
    const m = truncatedLine!.match(/助手: ([^\n]*)/);
    expect(m).not.toBeNull();
    const body = m![1]!;
    // slice(0, LIMIT - 1) + "…" = 799 + 1 = 800 chars.
    expect(body.length).toBe(800);
    expect(body.endsWith("…")).toBe(true);
    expect(body.startsWith("x".repeat(50))).toBe(true);
    expect(body.length).toBeGreaterThan(500);
    // The latest assistant line is untruncated.
    expect(text).toContain("助手: 最新回复，简短。");
  });

  it("the latest assistant message is exempt from truncation even when long", async () => {
    const long = "x".repeat(1500);
    const bridge = makeBridge([assistantEventWithText(long)]);
    const texts = await runHistory(bridge);
    const text = texts.join("\n");
    // The single assistant is the latest → body must NOT carry "…".
    const lineMatch = text.match(/助手: ([^\n]*)/);
    expect(lineMatch).not.toBeNull();
    const body = lineMatch![1]!;
    expect(body).not.toContain("…");
    expect(body.length).toBeGreaterThanOrEqual(1500);
  });

  it("the latest assistant is untruncated even when followed by a user message", async () => {
    const longAssistant = "y".repeat(1500);
    const bridge = makeBridge([
      assistantEventWithText(longAssistant, 1000),
      userEventWithText("用户的追问", 2000),
    ]);
    const texts = await runHistory(bridge);
    const text = texts.join("\n");
    // Find the assistant line — it must be untruncated.
    const lineMatch = text.match(/助手: ([^\n]*)/);
    expect(lineMatch).not.toBeNull();
    const assistantBody = lineMatch![1]!;
    expect(assistantBody).not.toContain("…");
    expect(assistantBody.length).toBeGreaterThanOrEqual(1500);
    // The user line is short → passes through.
    expect(text).toContain("你: 用户的追问");
  });

  it("history-with-cards still runs alongside the truncation exemption", async () => {
    const long = "x".repeat(1500);
    const bridge = makeBridge([assistantEventWithText(long)]);
    // Register a pending question card so /history also re-sends the full card.
    const api: { respond: unknown; events: { mux: () => AsyncIterable<unknown> } } = {
      respond: vi.fn().mockResolvedValue({ accepted: true }),
      events: { mux: () => (async function* () {})() },
    };
    (bridge as unknown as { attachMux(api: unknown): void }).attachMux(api);
    (bridge as unknown as { handleMuxFrame: (f: unknown) => void }).handleMuxFrame({
      type: "server-request",
      rpcId: "q-rpc",
      method: "question/requested",
      payload: {
        type: "question/requested",
        sessionId: "wx-1",
        questions: [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }] }],
      },
    });
    const texts = await runHistory(bridge);
    expect(texts.some((t) => t.includes("Continue?"))).toBe(true);
    // The untruncated latest assistant reply still flows through (no "…").
    expect(texts.some((t) => /助手: x{1500}/.test(t))).toBe(true);
  });
});