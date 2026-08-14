/**
 * Integration tests for the frame-driven card flow: frames → pending tables
 * → respond() injection. The WeChat send layer is mocked so no network
 * traffic happens; the bridge instance is driven directly.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage: vi.fn().mockResolvedValue(undefined),
  sendMediaMessage: vi.fn().mockResolvedValue(undefined),
  splitText: (text: string, maxLen: number) =>
    text.length <= maxLen ? [text] : [text.slice(0, maxLen), text.slice(maxLen)],
}));

import { WeChatDSHBridge, type ApiProxySurface } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";

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
  (bridge as unknown as { contextTokens: Map<string, string> }).contextTokens.set("u1", "tok");
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

describe("frame-driven approval cards", () => {
  let bridge: WeChatDSHBridge;
  let respondMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = makeBridge();
    respondMock = vi.fn().mockResolvedValue({ accepted: true });
    const api: ApiProxySurface = {
      respond: respondMock as never,
      events: { mux: () => (async function* () {})() },
    };
    bridge.attachMux(api);
  });

  it("approval/requested frame registers a card and respond() injects the decision", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pendingApprovals: Map<string, unknown[]>;
      handleApprovalReply(u: string, t: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(approvalFrame("rpc-1", "a-1", "pwsh", { reason: "run command" }));

    const list = anyBridge.pendingApprovals.get("u1");
    expect(list?.length).toBe(1);
    expect((list![0] as { toolName: string }).toolName).toBe("pwsh");

    await anyBridge.handleApprovalReply("u1", "1");
    expect(respondMock).toHaveBeenCalledTimes(1);
    expect(respondMock).toHaveBeenCalledWith({
      type: "client-response",
      rpcId: "rpc-1",
      result: { ok: true, value: { sessionId: "wx-1", approvalId: "a-1", outcome: "allowed-once" } },
    });
    expect(anyBridge.pendingApprovals.get("u1") ?? []).toHaveLength(0);
  });

  it("reply 2 injects rejected", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleApprovalReply(u: string, t: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(approvalFrame("rpc-2", "a-2", "bash"));
    await anyBridge.handleApprovalReply("u1", "2");
    const call = respondMock.mock.calls[0]![0] as { result: { value: { outcome: string } } };
    expect(call.result.value.outcome).toBe("rejected");
  });

  it("not-pending receipt is surfaced without crashing", async () => {
    respondMock.mockResolvedValue({ accepted: false, reason: "not-pending" });
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleApprovalReply(u: string, t: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(approvalFrame("rpc-3", "a-3", "pwsh"));
    await anyBridge.handleApprovalReply("u1", "1");
    expect(anyBridge.pendingApprovals.get("u1") ?? []).toHaveLength(0);
  });

  it("approval/resolved frame removes the card", () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pendingApprovals: Map<string, unknown[]>;
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

  it("parallel cards support Pn= replies", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleApprovalReply(u: string, t: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(approvalFrame("rpc-a", "a-a", "pwsh"));
    anyBridge.handleMuxFrame(approvalFrame("rpc-b", "a-b", "run_code"));
    await anyBridge.handleApprovalReply("u1", "P1=1 P2=2");
    expect(respondMock).toHaveBeenCalledTimes(2);
    const outcomes = respondMock.mock.calls.map(
      (c) => (c[0] as { result: { value: { outcome: string } } }).result.value.outcome,
    );
    expect(outcomes).toEqual(["allowed-once", "rejected"]);
  });
});

describe("frame-driven question cards", () => {
  let bridge: WeChatDSHBridge;
  let respondMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = makeBridge();
    respondMock = vi.fn().mockResolvedValue({ accepted: true });
    const api: ApiProxySurface = {
      respond: respondMock as never,
      events: { mux: () => (async function* () {})() },
    };
    bridge.attachMux(api);
  });

  it("question/requested registers a card and respond() injects the answer", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleQuestionReply(u: string, t: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc-1"));
    await anyBridge.handleQuestionReply("u1", "2");
    expect(respondMock).toHaveBeenCalledTimes(1);
    const call = respondMock.mock.calls[0]![0] as {
      rpcId: string;
      result: { ok: true; value: { sessionId: string; answer: { answers: Array<{ id: string; selected: string[] }> } } };
    };
    expect(call.rpcId).toBe("q-rpc-1");
    expect(call.result.value.sessionId).toBe("wx-1");
    expect(call.result.value.answer.answers[0]!.selected).toEqual(["No"]);
  });

  it("/rq rejects all pending question cards with cancelled", async () => {
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      rejectPendingQuestion(u: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-rpc-2"));
    await anyBridge.rejectPendingQuestion("u1");
    expect(respondMock).toHaveBeenCalledTimes(1);
    const call = respondMock.mock.calls[0]![0] as { result: { ok: false; error: { code: string } } };
    expect(call.result).toEqual({ ok: false, error: { code: "cancelled" } });
  });
});
