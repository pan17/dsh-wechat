/**
 * Pushed-card dedupe for cross-session decision cards (full push):
 *
 *   - A non-current session's card is pushed IN FULL on arrival (card gate
 *     on) and its rpcId is recorded in `pushedCardRpcIds`.
 *   - A card created while the gate is off stays silent and unpushed; a
 *     later switch-in flush shows only those unseen cards and records them.
 *   - When the card leaves the pending table (resolve / timeout / /rp / /rq),
 *     the pushed marker clears so the next card for that rpcId can push again.
 *   - /history re-sends every still-answerable card (all sessions when the
 *     gate is on; current session only when it is off).
 *
 * Cards are seeded through `handleMuxFrame` (test/replay helper); no
 * `apiProxy.respond` mock is involved.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const sendTextMessage = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
  sendMediaMessage: vi.fn().mockResolvedValue(undefined),
  splitText: (text: string, maxLen: number) =>
    text.length <= maxLen ? [text] : [text.slice(0, maxLen), text.slice(maxLen)],
}));

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";

function makeBridge(cards = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-push-"));
  const ctx = { get: () => undefined, on: () => () => {} };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  cfg.crossSessionNotify = cards;
  cfg.notifyTaskEvents = false;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  const store = (bridge as unknown as {
    state: {
      ensureUser(u: string, c: string): unknown;
      update(u: string, p: unknown): void;
    };
  }).state;
  // User currently in session A. Session B is the "other" (non-current) session.
  store.ensureUser("u1", "C:\\work");
  store.update("u1", { sessionId: "A" });
  (bridge as unknown as { token: unknown }).token = { baseUrl: "https://x", token: "t" };
  return bridge;
}

function approvalFrame(rpcId: string, approvalId: string, sessionId = "B") {
  return {
    type: "server-request",
    rpcId,
    method: "approval/requested",
    payload: { type: "approval/requested", sessionId, approvalId, toolName: "pwsh" },
  };
}

function approvalResolvedFrame(approvalId: string, outcome: "allowed-once" | "rejected" | "cancelled", sessionId = "B") {
  return {
    type: "server-request",
    rpcId: `${approvalId}-resolved`,
    method: "approval/resolved",
    payload: { type: "approval/resolved", sessionId, approvalId, outcome },
  };
}

function questionFrame(rpcId: string, sessionId = "B") {
  return {
    type: "server-request",
    rpcId,
    method: "question/requested",
    payload: {
      type: "question/requested",
      sessionId,
      questions: [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
    },
  };
}

function questionResolvedFrame(rpcId: string, sessionId = "B") {
  return {
    type: "server-request",
    rpcId: `${rpcId}-resolved`,
    method: "question/resolved",
    payload: { type: "question/resolved", sessionId, questionRpcId: rpcId, outcome: "answered" },
  };
}

/** Full-card messages (question content or approval tool lines). */
function cardMessages(): string[] {
  return sendTextMessage.mock.calls
    .map((call) => call[1] as string)
    .filter((text) => text.includes("Continue?") || text.includes("pwsh"));
}

/**
 * Drain microtasks so fire-and-forget `sendQuestionCard` / `sendApprovalCard`
 * calls finish (they await `sessionContextLabel` before sending).
 */
async function flushPushes(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
});

describe("pushed-card dedupe: question cards", () => {
  it("non-current card is pushed in full on arrival and marked", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-1", "B"));
    await flushPushes();

    expect(cardMessages()).toHaveLength(1);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("q-1")).toBe(true);
  });

  it("second card pushes too, numbered across all pending (2/2, P2 tip)", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
    };
    anyBridge.handleMuxFrame(questionFrame("q-1", "B"));
    await flushPushes();
    sendTextMessage.mockClear();
    anyBridge.handleMuxFrame(questionFrame("q-2", "B"));
    await flushPushes();

    const texts = sendTextMessage.mock.calls.map((c) => c[1] as string);
    const second = texts.find((t) => t.includes("Continue?"));
    expect(second).toBeDefined();
    expect(second).toContain("提问卡 2/2");
    expect(second).toContain("来自其他会话");
    expect(second).toContain("P2=");
  });

  it("resolve clears the pushed marker", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-1", "B"));
    await flushPushes();
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("q-1")).toBe(true);

    anyBridge.handleMuxFrame(questionResolvedFrame("q-1", "B"));
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("q-1")).toBe(false);
  });

  it("switch-in flush shows only unseen cards; a second flush stays silent", async () => {
    // Card created while the gate is off → not pushed, not marked.
    const bridge = makeBridge(false);
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      flushPendingCardsForSession(u: string, s: string): Promise<void>;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-1", "B"));
    await flushPushes();
    expect(cardMessages()).toHaveLength(0);

    // Gate turned on, user switches into B → the unseen card is flushed.
    (bridge as unknown as { config: { crossSessionNotify: boolean } }).config.crossSessionNotify = true;
    await anyBridge.flushPendingCardsForSession("u1", "B");
    await flushPushes();
    expect(cardMessages()).toHaveLength(1);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("q-1")).toBe(true);

    // Already-shown card must not repeat on a second flush.
    sendTextMessage.mockClear();
    await anyBridge.flushPendingCardsForSession("u1", "B");
    expect(cardMessages()).toHaveLength(0);
  });

  it("timeout removes the card and clears the marker; the next batch pushes again", async () => {
    const bridge = makeBridge();
    const cfg = (bridge as unknown as { config: { cardTimeoutMs: number } }).config;
    cfg.cardTimeoutMs = 30;

    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-1", "B"));
    await flushPushes();
    expect(cardMessages()).toHaveLength(1);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("q-1")).toBe(true);

    await new Promise((r) => setTimeout(r, 80));
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("q-1")).toBe(false);
    expect((bridge as unknown as { pendingQuestions: Map<string, unknown[]> }).pendingQuestions.get("u1")?.length ?? 0).toBe(0);

    sendTextMessage.mockClear();
    anyBridge.handleMuxFrame(questionFrame("q-2", "B"));
    await flushPushes();
    expect(cardMessages()).toHaveLength(1);
  });
});

describe("pushed-card dedupe: approval cards", () => {
  it("non-current approval card is pushed in full on arrival and marked", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    await flushPushes();

    const texts = cardMessages();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("P1=1");
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(true);
  });

  it("resolve clears the pushed marker", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    await flushPushes();
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(true);

    anyBridge.handleMuxFrame(approvalResolvedFrame("ap-1", "allowed-once", "B"));
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(false);
  });

  it("resolving session B's card does not affect session C's marker", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    anyBridge.handleMuxFrame(approvalFrame("c-1", "cp-1", "C"));
    await flushPushes();
    expect(cardMessages()).toHaveLength(2);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(true);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("c-1")).toBe(true);

    anyBridge.handleMuxFrame(approvalResolvedFrame("ap-1", "allowed-once", "B"));
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(false);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("c-1")).toBe(true);
  });
});

describe("/history resend", () => {
  it("gate off: does not resend unseen cards of other sessions", async () => {
    const bridge = makeBridge(false);
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      resendPendingCardsForHistory(u: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-1", "B"));
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "C"));
    await flushPushes();
    expect(cardMessages()).toHaveLength(0);

    await anyBridge.resendPendingCardsForHistory("u1");
    expect(cardMessages()).toHaveLength(0);
  });

  it("gate on: resends every still-pending card of any session in full", async () => {
    const bridge = makeBridge(true);
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      resendPendingCardsForHistory(u: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-1", "B"));
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "C"));
    await flushPushes();
    sendTextMessage.mockClear();

    await anyBridge.resendPendingCardsForHistory("u1");
    const texts = sendTextMessage.mock.calls.map((c) => c[1] as string);
    expect(texts.some((t) => t.includes("2 张待处理卡片"))).toBe(true);
    expect(cardMessages()).toHaveLength(2);
  });
});
