/**
 * Notification dedupe for non-current session cards:
 *
 *   - First card for a non-current session → one notification.
 *   - Additional cards for the same session in the same batch → deduped.
 *   - After the last card is resolved (any path), the notified mark clears
 *     so the next batch produces a fresh notification.
 *
 * Regression target: previously `notifiedCardSessions` was only cleared by
 * `flushPendingCardsForSession` (user `/session switch`), so resolving cards
 * via GUI / WeChat reply / timeout / /rp / /rq never freed the mark — every
 * later card for the same non-current session was silently swallowed.
 *
 * NOTE: `notifyCardPending` is an async function called fire-and-forget
 * from `handleMuxFrame`; it sets the mark synchronously, then awaits
 * `sessionContextLabel` before sending the actual `sendReply`. Every test
 * awaits `flushNotifications()` after a frame to observe the notification.
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

function makeBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-notif-"));
  const ctx = { get: () => undefined, on: () => () => {} };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  cfg.crossSessionNotify = true;
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

/** Filter only the `🔔 ...待处理...` notification messages from sendTextMessage calls. */
function notificationMessages(): string[] {
  return sendTextMessage.mock.calls
    .map((call) => call[1] as string)
    .filter((text) => text.includes("🔔"));
}

/**
 * Drain microtasks so fire-and-forget `notifyCardPending` calls finish
 * (they set the mark synchronously, then `await sessionContextLabel` before
 * sending the `sendReply` notification).
 */
async function flushNotifications(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
});

describe("notification dedupe: question cards", () => {
  it("first card → notify; second card in same batch → deduped", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      notifiedCardSessions: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-1", "B"));
    anyBridge.handleMuxFrame(questionFrame("q-2", "B"));
    await flushNotifications();

    expect(notificationMessages()).toHaveLength(1);
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(true);
  });

  it("mark clears once the last card is resolved; next batch notifies again", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      notifiedCardSessions: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(questionFrame("q-1", "B"));
    anyBridge.handleMuxFrame(questionFrame("q-2", "B"));
    await flushNotifications();
    expect(notificationMessages()).toHaveLength(1);

    // Resolve first card — one card still pending, mark must stay.
    anyBridge.handleMuxFrame(questionResolvedFrame("q-1", "B"));
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(true);

    // Resolve second card — batch is over, mark must clear.
    anyBridge.handleMuxFrame(questionResolvedFrame("q-2", "B"));
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(false);

    // Next batch → fresh notification.
    anyBridge.handleMuxFrame(questionFrame("q-3", "B"));
    await flushNotifications();
    expect(notificationMessages()).toHaveLength(2);
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(true);
  });
});

describe("notification dedupe: approval cards", () => {
  it("first card → notify; same-batch second card → deduped", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      notifiedCardSessions: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    anyBridge.handleMuxFrame(approvalFrame("a-2", "ap-2", "B"));
    await flushNotifications();

    expect(notificationMessages()).toHaveLength(1);
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(true);
  });

  it("mark clears once the last approval card is resolved; next batch notifies again", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      notifiedCardSessions: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    anyBridge.handleMuxFrame(approvalFrame("a-2", "ap-2", "B"));
    await flushNotifications();
    expect(notificationMessages()).toHaveLength(1);

    anyBridge.handleMuxFrame(approvalResolvedFrame("ap-1", "allowed-once", "B"));
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(true);

    anyBridge.handleMuxFrame(approvalResolvedFrame("ap-2", "rejected", "B"));
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(false);

    anyBridge.handleMuxFrame(approvalFrame("a-3", "ap-3", "B"));
    await flushNotifications();
    expect(notificationMessages()).toHaveLength(2);
  });
});

describe("notification dedupe: timeout path", () => {
  it("card timeout (no reply) clears the mark → next batch notifies", async () => {
    const bridge = makeBridge();
    // Shrink the timeout so the test is fast.
    const cfg = (bridge as unknown as { config: { cardTimeoutMs: number } }).config;
    cfg.cardTimeoutMs = 30;

    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      notifiedCardSessions: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    await flushNotifications();
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(true);
    expect(notificationMessages()).toHaveLength(1);

    // Wait past the timeout. cardTimeoutMs=30ms + buffer for microtasks.
    await new Promise((r) => setTimeout(r, 80));
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(false);

    anyBridge.handleMuxFrame(approvalFrame("a-2", "ap-2", "B"));
    await flushNotifications();
    expect(notificationMessages()).toHaveLength(2);
  });
});

describe("notification dedupe: cross-session isolation", () => {
  it("resolving cards for session B does not affect session C's notification mark", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      notifiedCardSessions: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    anyBridge.handleMuxFrame(approvalFrame("c-1", "cp-1", "C"));
    await flushNotifications();
    expect(notificationMessages()).toHaveLength(2);
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(true);
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("C")).toBe(true);

    // Resolve B → only B's mark clears.
    anyBridge.handleMuxFrame(approvalResolvedFrame("ap-1", "allowed-once", "B"));
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(false);
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("C")).toBe(true);
  });
});

describe("notification dedupe: switch-in still clears mark (existing behavior)", () => {
  it("switching into the notified session clears the mark", async () => {
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      flushPendingCardsForSession(u: string, s: string): Promise<void>;
      notifiedCardSessions: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    await flushNotifications();
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(true);

    // Simulate /session switch B: user switches into B, cards flushed,
    // line 1113 explicitly clears the notified mark.
    (bridge as unknown as { state: { update(u: string, p: unknown): void } }).state.update("u1", { sessionId: "B" });
    await anyBridge.flushPendingCardsForSession("u1", "B");
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(false);

    // Switch back to A, new B card → fresh notification.
    (bridge as unknown as { state: { update(u: string, p: unknown): void } }).state.update("u1", { sessionId: "A" });
    anyBridge.handleMuxFrame(approvalFrame("a-2", "ap-2", "B"));
    await flushNotifications();
    expect(notificationMessages()).toHaveLength(2);
  });
});

describe("notification dedupe: WeChat reply path (mark cleared via removeApprovalCard)", () => {
  it("after switching into B, a WeChat reply calls removeApprovalCard which is a no-op on mark", async () => {
    // This is the realistic scenario: user switches into B (mark cleared by
    // flushPendingCardsForSession), then replies from WeChat → removeApprovalCard
    // runs but the mark was already cleared — invariant preserved.
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
      notifiedCardSessions: Map<string, Set<string>>;
    };
    anyBridge.handleMuxFrame(approvalFrame("a-1", "ap-1", "B"));
    await flushNotifications();
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(true);

    // Switch into B → flushPendingCardsForSession clears the mark.
    (bridge as unknown as { state: { update(u: string, p: unknown): void } }).state.update("u1", { sessionId: "B" });
    // Trigger the same code path that /session switch takes on line 1113.
    const bridge2 = bridge as unknown as {
      flushPendingCardsForSession(u: string, s: string): Promise<void>;
    };
    await bridge2.flushPendingCardsForSession("u1", "B");
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(false);

    // Reply from WeChat → removeApprovalCard runs (covered by frames.test.ts).
    // The helper is a no-op here since mark was already cleared.
    await anyBridge.handleApprovalReply("u1", "1");
    expect(anyBridge.notifiedCardSessions.get("u1")?.has("B")).toBe(false);
    expect(respondMock).toHaveBeenCalledTimes(1);
  });
});