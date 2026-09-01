/**
 * Integration tests for the frame-driven card flow: frames → pending tables
 * → respond() injection. The WeChat send layer is mocked so no network
 * traffic happens; the bridge instance is driven directly.
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

function makeBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-frame-"));
  const ctx = { get: () => undefined, on: () => () => {} };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  // Seed one bound user + token/context so sendReply paths work.
  const store = (bridge as unknown as { state: { ensureUser(u: string, c: string): unknown } }).state;
  store.ensureUser("u1", "C:\\work");
  (bridge as unknown as { state: { update(u: string, p: unknown): void } }).state.update("u1", { sessionId: "wx-1" });
  (bridge as unknown as { token: unknown }).token = { baseUrl: "https://x", token: "t" };
  return bridge;
}

function approvalFrame(rpcId: string, approvalId: string, toolName: string, extra: Record<string, unknown> = {}) {
  return {
    type: "server-request",
    rpcId,
    method: "approval/requested",
    payload: { type: "approval/requested", sessionId: "wx-1", approvalId, toolName, ...extra },
  };
}

function questionFrame(rpcId: string) {
  return {
    type: "server-request",
    rpcId,
    method: "question/requested",
    payload: {
      type: "question/requested",
      sessionId: "wx-1",
      questions: [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
    },
  };
}

function captureApprovalOutcomes(bridge: WeChatDSHBridge): Array<"allowed-once" | "rejected"> {
  const anyBridge = bridge as unknown as {
    pendingApprovals: Map<string, Array<{ settleWechat: ((o: "allowed-once" | "rejected") => void) | null }>>;
  };
  const list = anyBridge.pendingApprovals.get("u1") ?? [];
  const card = list[list.length - 1];
  const outcomes: Array<"allowed-once" | "rejected"> = [];
  if (card) card.settleWechat = (o) => outcomes.push(o);
  return outcomes;
}

function captureQuestionAnswers(bridge: WeChatDSHBridge): unknown[] {
  const anyBridge = bridge as unknown as {
    pendingQuestions: Map<string, Array<{
      settleWechat: ((a: unknown) => void) | null;
      cancelWechat: ((r: unknown) => void) | null;
    }>>;
  };
  const list = anyBridge.pendingQuestions.get("u1") ?? [];
  const card = list[list.length - 1];
  const answers: unknown[] = [];
  if (card) {
    card.settleWechat = (a) => answers.push(a);
    card.cancelWechat = (r) => answers.push({ cancelled: true, reason: r });
  }
  return answers;
}

describe("frame-driven approval cards", () => {
  let bridge: WeChatDSHBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = makeBridge();
  });

  it("approval/requested frame registers a card and respond() injects the decision", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pendingApprovals: unknown[];
      handleApprovalReply(u: string, t: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(approvalFrame("rpc-1", "a-1", "pwsh", { reason: "run command" }));

    const list = anyBridge.pendingApprovals.get("u1");
    expect(list?.length).toBe(1);
    expect((list![0] as { toolName: string }).toolName).toBe("pwsh");

    const outcomes = captureApprovalOutcomes(bridge);
    await anyBridge.handleApprovalReply("u1", "1");
    expect(outcomes).toEqual(["allowed-once"]);
    expect(anyBridge.pendingApprovals.get("u1") ?? []).toHaveLength(0);
  });

  it("reply 2 injects rejected", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleApprovalReply(u: string, t: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(approvalFrame("rpc-2", "a-2", "bash"));
    const outcomes = captureApprovalOutcomes(bridge);
    await anyBridge.handleApprovalReply("u1", "2");
    expect(outcomes).toEqual(["rejected"]);
  });

  it("not-pending receipt is surfaced without crashing", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleApprovalReply(u: string, t: string): Promise<void>;
      pendingApprovals: Map<string, Array<{ settled: boolean }>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("rpc-3", "a-3", "pwsh"));
    const card = anyBridge.pendingApprovals.get("u1")![0]!;
    card.settled = true;
    await anyBridge.handleApprovalReply("u1", "1");
    expect(anyBridge.pendingApprovals.get("u1") ?? []).toHaveLength(0);
  });

  it("approval/resolved frame removes the card", () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pendingApprovals: unknown[];
    };
    anyBridge.handleMuxFrame(approvalFrame("rpc-4", "a-4", "pwsh"));
    expect(anyBridge.pendingApprovals.get("u1")?.length).toBe(1);
    anyBridge.handleMuxFrame({
      type: "server-request",
      rpcId: "rpc-x",
      method: "approval/resolved",
      payload: { type: "approval/resolved", sessionId: "wx-1", approvalId: "a-4", outcome: "allowed-once" },
    });
    expect(anyBridge.pendingApprovals.get("u1") ?? []).toHaveLength(0);
  });

  it("approval/requested still registers when bot token is missing, and does not park the card", () => {
    const loggedOut = makeBridge();
    (loggedOut as unknown as { token: unknown }).token = null;
    const anyBridge = loggedOut as unknown as {
      handleMuxFrame(f: unknown): void;
      pendingApprovals: unknown[];
      outboundCache: unknown[];
    };
    anyBridge.handleMuxFrame(approvalFrame("rpc-offline", "a-off", "pwsh"));
    expect(anyBridge.pendingApprovals.get("u1")?.length).toBe(1);
    expect(anyBridge.outboundCache).toHaveLength(0);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("parallel cards support Pn= replies", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleApprovalReply(u: string, t: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(approvalFrame("rpc-a", "a-a", "pwsh"));
    const first = captureApprovalOutcomes(bridge);
    anyBridge.handleMuxFrame(approvalFrame("rpc-b", "a-b", "run_code"));
    const second = captureApprovalOutcomes(bridge);
    await anyBridge.handleApprovalReply("u1", "P1=1 P2=2");
    expect([...first, ...second]).toEqual(["allowed-once", "rejected"]);
  });
});

describe("frame-driven question cards", () => {
  let bridge: WeChatDSHBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = makeBridge();
  });

  it("question/requested registers a card and respond() injects the answer", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleQuestionReply(u: string, t: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc-1"));
    const answers = captureQuestionAnswers(bridge);
    await anyBridge.handleQuestionReply("u1", "2");
    expect(answers).toHaveLength(1);
    const answer = answers[0] as { answers: Array<{ id: string; selected: string[] }> };
    expect(answer.answers[0]!.selected).toEqual(["No"]);
  });

  it("/rq rejects all pending question cards with cancelled", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      rejectPendingQuestion(u: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc-2"));
    const answers = captureQuestionAnswers(bridge);
    await anyBridge.rejectPendingQuestion("u1");
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ cancelled: true });
  });
});

/** A bare user text message, mirroring forwarding.test.ts's helper. */
function userTextMessage(text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

describe("card-bypass for slash commands", () => {
  let bridge: WeChatDSHBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = makeBridge();
  });

  it("question card + /next flushes cache and leaves the card pending", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
      outboundCache: unknown[];
      pendingQuestions: unknown[];
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc"));
    anyBridge.outboundCache = [{ kind: "text", text: "cached" }];
    await anyBridge.handleMessage(userTextMessage("/next"));
    // /next flushed the cache to WeChat.
    expect(sendTextMessage).toHaveBeenCalled();
    // The card was NOT answered.
    expect(anyBridge.pendingQuestions.get("u1")?.length).toBe(1);
  });

  it("approval card + /next flushes cache and leaves the card pending", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
      outboundCache: unknown[];
      pendingApprovals: unknown[];
    };
    anyBridge.handleMuxFrame(approvalFrame("a-rpc", "a-id", "pwsh"));
    anyBridge.outboundCache = [{ kind: "text", text: "cached" }];
    await anyBridge.handleMessage(userTextMessage("/next"));
    expect(sendTextMessage).toHaveBeenCalled();
    expect(anyBridge.pendingApprovals.get("u1")?.length).toBe(1);
  });

  it("question card + /status shows status and leaves the card pending", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
      pendingQuestions: unknown[];
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc"));
    sendTextMessage.mockClear();
    await anyBridge.handleMessage(userTextMessage("/status"));
    expect(sendTextMessage).toHaveBeenCalled();
    const statusText = sendTextMessage.mock.calls.map((c) => String(c[1])).join("\n");
    expect(statusText).toContain("🔴 • 待处理: 1 张提问卡");
    expect(anyBridge.pendingQuestions.get("u1")?.length).toBe(1);
  });

  it("/status lists both question and approval cards", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc"));
    anyBridge.handleMuxFrame(approvalFrame("a-rpc", "a-id", "pwsh"));
    sendTextMessage.mockClear();
    await anyBridge.handleMessage(userTextMessage("/status"));
    const statusText = sendTextMessage.mock.calls.map((c) => String(c[1])).join("\n");
    expect(statusText).toContain("🔴 • 待处理: 1 张提问卡 · 1 张权限卡");
  });

  it("/history resends the full pending question card after the empty-history notice", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
      pendingQuestions: unknown[];
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc"));
    sendTextMessage.mockClear();
    await anyBridge.handleMessage(userTextMessage("/history"));
    const texts = sendTextMessage.mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => t.includes("暂无历史消息") || t.includes("最近"))).toBe(true);
    expect(texts.some((t) => t.includes("待处理卡片"))).toBe(true);
    expect(texts.some((t) => t.includes("Continue?"))).toBe(true);
    expect(anyBridge.pendingQuestions.get("u1")?.length).toBe(1);
  });

  it("/history resends the full pending approval card", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
      pendingApprovals: unknown[];
    };
    anyBridge.handleMuxFrame(approvalFrame("a-rpc", "a-id", "pwsh"));
    sendTextMessage.mockClear();
    await anyBridge.handleMessage(userTextMessage("/history"));
    const texts = sendTextMessage.mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => t.includes("需要权限确认") || t.includes("pwsh"))).toBe(true);
    expect(anyBridge.pendingApprovals.get("u1")?.length).toBe(1);
  });

  it("question card + /help shows help and leaves the card pending", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
      pendingQuestions: unknown[];
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc"));
    await anyBridge.handleMessage(userTextMessage("/help"));
    // /help prints the help text via sendTextMessage.
    expect(sendTextMessage).toHaveBeenCalled();
    expect(anyBridge.pendingQuestions.get("u1")?.length).toBe(1);
  });

  it("question card + /rq still rejects (card-specific command stays)", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
      pendingQuestions: unknown[];
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc"));
    const answers = captureQuestionAnswers(bridge);
    await anyBridge.handleMessage(userTextMessage("/rq"));
    expect(answers).toHaveLength(1);
    expect(anyBridge.pendingQuestions.get("u1") ?? []).toHaveLength(0);
  });

  it("approval card + /rp still rejects (card-specific command stays)", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
      pendingApprovals: unknown[];
    };
    anyBridge.handleMuxFrame(approvalFrame("a-rpc", "a-id", "pwsh"));
    const outcomes = captureApprovalOutcomes(bridge);
    await anyBridge.handleMessage(userTextMessage("/rp"));
    expect(outcomes).toEqual(["rejected"]);
    expect(anyBridge.pendingApprovals.get("u1") ?? []).toHaveLength(0);
  });

  it("plain text still answers a pending question card (existing behaviour)", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
      pendingQuestions: unknown[];
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc"));
    const answers = captureQuestionAnswers(bridge);
    await anyBridge.handleMessage(userTextMessage("1"));
    expect(answers).toHaveLength(1);
    expect(anyBridge.pendingQuestions.get("u1") ?? []).toHaveLength(0);
  });

  it("unknown slash command still answers a pending question card", async () => {
    // Unrecognized slash commands fall through to parseQuestionReply and
    // are submitted as the question's custom-text answer — the bridge's
    // "unknown slash command" hint is only emitted in the non-card path.
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc"));
    const answers = captureQuestionAnswers(bridge);
    await anyBridge.handleMessage(userTextMessage("/foobar"));
    expect(answers).toHaveLength(1);
  });

  it("empty text still triggers the card-handler hint (bypassCard is false)", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc"));
    await anyBridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "tok",
      item_list: [{ type: 2 /* IMAGE — extractText skips non-text */ }],
    });
    // Empty text + pending question → hint message, no card answer.
    expect(sendTextMessage).toHaveBeenCalled();
    const pending = (bridge as unknown as { pendingQuestions: Map<string, unknown[]> }).pendingQuestions;
    expect(pending.get("u1")?.length).toBe(1);
  });
});

describe("waterfall race: WeChat vs GUI", () => {
  let bridge: WeChatDSHBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = makeBridge();
  });

  it("no WeChat peer immediately next()s", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-empty-"));
    const ctx = { get: () => undefined, on: () => () => {} };
    const cfg = defaultConfig();
    cfg.storageDir = dir;
    const empty = new WeChatDSHBridge(ctx, cfg);
    const next = vi.fn().mockResolvedValue("unavailable");
    const outcome = await empty.answerApprovalRequest(
      { agent: { id: "orphan" }, toolName: "pwsh" },
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("unavailable");
  });

  it("WeChat reply wins the approval race", async () => {
    let resolveGui: ((o: "allowed-once" | "rejected") => void) | undefined;
    const gui = new Promise<"allowed-once" | "rejected">((resolve) => {
      resolveGui = resolve;
    });
    const pending = bridge.answerApprovalRequest(
      { agent: { id: "wx-1" }, toolName: "pwsh", reason: "run" },
      () => gui,
    );
    await Promise.resolve();
    const anyBridge = bridge as unknown as {
      handleApprovalReply(u: string, t: string): Promise<void>;
    };
    await anyBridge.handleApprovalReply("u1", "1");
    await expect(pending).resolves.toBe("allowed-once");
    resolveGui?.("rejected");
  });

  it("GUI next() wins the approval race", async () => {
    const pending = bridge.answerApprovalRequest(
      { agent: { id: "wx-1" }, toolName: "pwsh" },
      async () => "rejected",
    );
    await expect(pending).resolves.toBe("rejected");
    const cards = (bridge as unknown as { pendingApprovals: Map<string, unknown[]> }).pendingApprovals;
    expect(cards.get("u1") ?? []).toHaveLength(0);
  });

  it("WeChat answer wins the question race", async () => {
    let resolveGui: ((a: { answers: Array<{ id: string; selected: string[] }> }) => void) | undefined;
    const gui = new Promise<{ answers: Array<{ id: string; selected: string[] }> }>((resolve) => {
      resolveGui = resolve;
    });
    const pending = bridge.answerQuestionRequest(
      {
        agent: { id: "wx-1" },
        questions: [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
      },
      () => gui,
    );
    await Promise.resolve();
    const anyBridge = bridge as unknown as {
      handleQuestionReply(u: string, t: string): Promise<void>;
    };
    await anyBridge.handleQuestionReply("u1", "2");
    const answer = await pending;
    expect(answer.answers[0]!.selected).toEqual(["No"]);
    resolveGui?.({ answers: [{ id: "q1", selected: ["Yes"] }] });
  });
});
