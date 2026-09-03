/**
 * Full-card push machinery for cross-session cards (patch suite semantics):
 *
 *   - A card for a non-current session (decision gate on) is pushed IN FULL
 *     at arrival and marked pushed (`pushedCardRpcIds`).
 *   - Every card of a batch pushes once at arrival (no dedupe needed — each
 *     message is a complete, directly answerable card).
 *   - Resolving / timing out a card clears its pushed mark, so the same
 *     rpcId can never be mistaken for "already shown" again.
 *   - `/session switch` into the card's session does NOT re-send cards that
 *     were already pushed at arrival; cards that never got pushed (gate off
 *     at arrival) are flushed on switch.
 *
 * Regression target: previously non-current cards were only "notified" once
 * (`notifiedCardSessions`) and flushed on switch — resolving cards via
 * GUI / WeChat / timeout never freed the mark, so later cards for the same
 * non-current session were silently swallowed. The patch suite replaces the
 * notice with the full card, so the mark now tracks what was actually shown.
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

import { WeChatDSHBridge, type ApiProxySurface } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";

function makeBridge(crossSessionNotify = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-notif-"));
  const ctx = { get: () => undefined, on: () => () => {} };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  cfg.crossSessionNotify = crossSessionNotify;
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

/** Sent text payloads of full approval cards (they name the tool). */
function approvalCardMessages(): string[] {
  return sendTextMessage.mock.calls
    .map((call) => call[1] as string)
    .filter((text) => text.includes("pwsh"));
}

/** Sent text payloads of full question cards. */
function questionCardMessages(): string[] {
  return sendTextMessage.mock.calls
    .map((call) => call[1] as string)
    .filter((text) => text.includes("Continue?"));
}

/** Drain microtasks so fire-and-forget card sends finish. */
async function flushNotifications(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
});

describe("full-card push: approval cards", () => {
  it("pushes the full card at arrival and marks it pushed", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    await flushNotifications();

    expect(approvalCardMessages()).toHaveLength(1);
    expect(approvalCardMessages()[0]).toContain("📂");
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(true);
  });

  it("every card of a batch pushes once at arrival (no dedupe needed)", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as { handleMuxFrame(f: unknown): void };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    anyBridge.handleMuxFrame(approvalFrame("a-2", "ap-2", "B"));
    await flushNotifications();

    expect(approvalCardMessages()).toHaveLength(2);
  });

  it("resolving a card clears its pushed mark; the other card keeps it", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    anyBridge.handleMuxFrame(approvalFrame("a-2", "ap-2", "B"));
    await flushNotifications();
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(true);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-2")).toBe(true);

    anyBridge.handleMuxFrame(approvalResolvedFrame("ap-1", "allowed-once", "B"));
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(false);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-2")).toBe(true);
  });
});

describe("full-card push: question cards", () => {
  it("pushes the full question card at arrival", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as { handleMuxFrame(f: unknown): void };
    anyBridge.handleMuxFrame(questionFrame("q-1", "B"));
    await flushNotifications();

    expect(questionCardMessages()).toHaveLength(1);
    expect(questionCardMessages()[0]).toContain("Continue?");
  });

  it("resolving a question card clears its pushed mark", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-1", "B"));
    await flushNotifications();
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("q-1")).toBe(true);

    anyBridge.handleMuxFrame(questionResolvedFrame("q-1", "B"));
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("q-1")).toBe(false);
  });
});

describe("full-card push: timeout path", () => {
  it("card timeout clears the pushed mark", async () => {
    const bridge = makeBridge();
    const cfg = (bridge as unknown as { config: { cardTimeoutMs: number } }).config;
    cfg.cardTimeoutMs = 30;

    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    await flushNotifications();
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(true);

    await new Promise((r) => setTimeout(r, 80));
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(false);
  });
});

describe("full-card push: cross-session isolation", () => {
  it("resolving session B's card does not affect session C's pushed mark", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pushedCardRpcIds: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    anyBridge.handleMuxFrame(approvalFrame("c-1", "cp-1", "C"));
    await flushNotifications();
    expect(approvalCardMessages()).toHaveLength(2);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(true);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("c-1")).toBe(true);

    anyBridge.handleMuxFrame(approvalResolvedFrame("ap-1", "allowed-once", "B"));
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("a-1")).toBe(false);
    expect(anyBridge.pushedCardRpcIds.get("u1")?.has("c-1")).toBe(true);
  });
});

describe("full-card push: switch-in flush", () => {
  it("does not re-send a card that was already pushed at arrival", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      flushPendingCardsForSession(u: string, s: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    await flushNotifications();
    expect(approvalCardMessages()).toHaveLength(1);

    // Switch into B → flush must NOT repeat the already-pushed card.
    (bridge as unknown as { state: { update(u: string, p: unknown): void } }).state.update("u1", { sessionId: "B" });
    await anyBridge.flushPendingCardsForSession("u1", "B");
    expect(approvalCardMessages()).toHaveLength(1);
  });

  it("flushes cards that never got pushed (gate off at arrival)", async () => {
    const bridge = makeBridge(false);
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      flushPendingCardsForSession(u: string, s: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    await flushNotifications();
    expect(approvalCardMessages()).toHaveLength(0);

    (bridge as unknown as { state: { update(u: string, p: unknown): void } }).state.update("u1", { sessionId: "B" });
    await anyBridge.flushPendingCardsForSession("u1", "B");
    await flushNotifications();
    expect(approvalCardMessages()).toHaveLength(1);
  });
});

describe("full-card push: WeChat reply path", () => {
  it("answers a non-current session's card directly from WeChat", async () => {
    const bridge = makeBridge();
    const respondMock = vi.fn().mockResolvedValue({ accepted: true });
    const api: ApiProxySurface = {
      respond: respondMock as never,
      events: { mux: () => (async function* () {})() },
    };
    bridge.attachMux(api);

    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleApprovalReply(u: string, t: string): Promise<void>;
    };
    // Card for session B while the user is bound to session A.
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    await flushNotifications();

    await anyBridge.handleApprovalReply("u1", "1");
    expect(respondMock).toHaveBeenCalledTimes(1);
    expect((respondMock.mock.calls[0] as unknown[])[0]).toMatchObject({
      result: { ok: true, value: { outcome: "allowed-once" } },
    });
  });

  it("blocks a bare reply when cards span several sessions", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleApprovalReply(u: string, t: string): Promise<void>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    anyBridge.handleMuxFrame(approvalFrame("a-2", "ap-2", "C"));
    await flushNotifications();
    sendTextMessage.mockClear();

    await anyBridge.handleApprovalReply("u1", "1");
    const texts = sendTextMessage.mock.calls.map((c) => c[1] as string);
    expect(texts.some((t: string) => t.includes("为避免误操作"))).toBe(true);
  });
});
