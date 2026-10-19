/**
 * Regression tests for the three defects found in PR #11's delivery-hardening
 * work (reviewed against the DSH 0.2.x host).
 *
 * Every test here drives the REAL production entry points — `deliverOutbound`
 * / `handleSessionEvent` — rather than calling `parkOutbound` directly. That
 * distinction is the whole point: the pre-existing cap tests called
 * `parkOutbound` in isolation, which skips the `serializeOutbound` slot, so
 * they could not observe a re-entrant lock acquisition.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
import { MAX_OUTBOUND_QUEUE, MAX_OUTBOUND_QUEUE_HARD, type UserState } from "../src/state.js";

type AnyBridge = {
  token: unknown;
  tokenInvalid: boolean;
  wechatMsgCount: number;
  outboundCache: Array<{ kind: string; text?: string }>;
  outboundSerial: Promise<void>;
  deliverOutbound(userId: string, item: { kind: "text"; text: string }): Promise<string>;
  parkOutbound(userId: string, item: { kind: "text"; text: string }): Promise<void>;
  handleSessionEvent(sessionId: string, event: unknown): void;
  state: {
    ensureUser(u: string, c: string): UserState;
    update(u: string, p: unknown): void;
    all(): UserState[];
  };
};

function makeMockAgent(id: string) {
  const received: Array<{ content: unknown; source: unknown }> = [];
  return {
    agent: {
      id,
      status: "idle",
      options: { provider: "deepseek", model: "deepseek-chat" },
      followup: (m: { content: unknown; source: unknown }) => received.push(m),
      steer: () => {},
      cancel: () => {},
      whenIdle: async () => {},
    },
    received,
  };
}

function makeBridge(agent: { agent: unknown; received: unknown[] }, loggedIn: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-cap-"));
  const agentsService = {
    create: async () => agent,
    resume: async () => agent,
    get: (id: string) => (id === (agent.agent as { id: string }).id ? agent.agent : undefined),
    list: () => [agent.agent],
  };
  // Mirrors the cross-session suite's context: recipient resolution needs the
  // workspace registry and the session query to enumerate candidate sessions.
  const ctx: any = {
    get: (name: string) => {
      if (name === "agents") return agentsService;
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
  cfg.notifyTaskEvents = true;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  if (loggedIn) {
    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw",
      token: "t",
      accountId: "b1",
      userId: "u",
      savedAt: "",
    };
  }
  return { bridge, storageDir: dir };
}

function bindUser(store: AnyBridge["state"], sessionId: string): void {
  store.ensureUser("u1", "C:\\work");
  (store as unknown as { update(u: string, p: unknown): void }).update("u1", { sessionId });
}

/** Race a promise against a deadline; resolves to "timeout" when it hangs. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("cap-pressure force-send does not self-deadlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivering into a full cache settles (no re-entrant serializeOutbound)", async () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, true);
    const anyBridge = bridge as unknown as AnyBridge;

    // A closed gateway window is what fills the queue; every direct send parks.
    anyBridge.wechatMsgCount = 10;
    sendTextMessage.mockRejectedValue(
      Object.assign(new Error("rate limited"), { code: "MSG_LIMIT" }),
    );

    // Fill exactly to the soft cap through the REAL serialized entry point.
    for (let i = 0; i < MAX_OUTBOUND_QUEUE; i++) {
      const outcome = await within(anyBridge.deliverOutbound("u1", { kind: "text", text: `msg-${i}` }), 2000);
      expect(outcome).not.toBe("timeout");
      expect(outcome).toBe("cached");
    }
    expect(anyBridge.outboundCache).toHaveLength(MAX_OUTBOUND_QUEUE);

    // This delivery is the one that crosses the cap and triggers the
    // force-send from inside the already-held lock. Before the fix it never
    // settled — and it wedged every later send with it.
    const outcome = await within(
      anyBridge.deliverOutbound("u1", { kind: "text", text: "msg-over-cap" }),
      2000,
    );
    expect(outcome).not.toBe("timeout");
    expect(outcome).toBe("cached");
  });

  it("the outbound chain still works after cap pressure (no wedged serial)", async () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, true);
    const anyBridge = bridge as unknown as AnyBridge;

    anyBridge.wechatMsgCount = 10;
    sendTextMessage.mockRejectedValue(
      Object.assign(new Error("rate limited"), { code: "MSG_LIMIT" }),
    );

    for (let i = 0; i <= MAX_OUTBOUND_QUEUE; i++) {
      await within(anyBridge.deliverOutbound("u1", { kind: "text", text: `msg-${i}` }), 2000);
    }

    // The window reopens. The chain must still make progress through the
    // serialized path — a wedged `outboundSerial` would leave this pending
    // forever. (The flush itself stops at the 10-message budget window, so
    // "made progress" is the property under test, not "drained".)
    sendTextMessage.mockResolvedValue(undefined);
    anyBridge.wechatMsgCount = 0;
    const before = anyBridge.outboundCache.length;
    const flush = await within(
      (bridge as unknown as { flushPending(u: string, o?: unknown): Promise<void> }).flushPending(
        "u1",
        { silent: true },
      ),
      2000,
    );
    expect(flush).not.toBe("timeout");
    expect(anyBridge.outboundCache.length).toBeLessThan(before);
  });
});

describe("hard ceiling bounds memory when the force-send cannot deliver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("an undeliverable backlog stays bounded instead of growing without limit", async () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, true);
    const anyBridge = bridge as unknown as AnyBridge;

    // Nothing can leave: the window is closed AND every send fails.
    anyBridge.wechatMsgCount = 10;
    sendTextMessage.mockRejectedValue(
      Object.assign(new Error("rate limited"), { code: "MSG_LIMIT" }),
    );

    const pushes = MAX_OUTBOUND_QUEUE_HARD + 50;
    for (let i = 0; i < pushes; i++) {
      await within(anyBridge.deliverOutbound("u1", { kind: "text", text: `msg-${i}` }), 2000);
    }

    // The soft cap alone would have let this reach `pushes`. The hard ceiling
    // is what actually bounds it.
    expect(anyBridge.outboundCache.length).toBeLessThanOrEqual(MAX_OUTBOUND_QUEUE_HARD);
    expect(anyBridge.outboundCache.length).toBeLessThan(pushes);
    // Every attempt is audited; the sink must have stayed cheap enough that the
    // 450-iteration loop fits comfortably inside this budget.
  }, 60_000);
});

describe("cross-session completion notice is not suppressed forever while offline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` does not restore implementations, and the cap tests above
    // leave `sendTextMessage` rejecting. Restore a working send explicitly.
    sendTextMessage.mockResolvedValue(undefined);
  });

  it("a completion during an outage does not block a later, deliverable one", async () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, true);
    const anyBridge = bridge as unknown as AnyBridge;

    // u1 is bound to sess-A; the notice is for a DIFFERENT session, so it
    // takes the cross-session path. sess-B must be watched for recipient
    // resolution to consider it.
    bindUser(anyBridge.state, "sess-A");
    (anyBridge.state as unknown as { watchSession(u: string, s: string): void }).watchSession("u1", "sess-B");
    anyBridge.tokenInvalid = true; // bot unreachable

    // `handleSessionEvent` dedupes on `[sessionId, seq]`, so each event needs a
    // distinct seq or the second round would be swallowed as a replay.
    let seq = 0;
    const completion = (text: string) => ({
      type: "assistant/message",
      seq: seq++,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text }] } },
    });
    const turnEnd = () => ({ type: "turn/end", seq: seq++, time: Date.now(), data: { turn: 1 } });

    // A background session completes while the bot is unreachable.
    anyBridge.handleSessionEvent("sess-B", completion("离线期间的结论"));
    anyBridge.handleSessionEvent("sess-B", turnEnd());
    await new Promise((r) => setTimeout(r, 150));
    const duringOutage = sendTextMessage.mock.calls.length;
    expect(duringOutage).toBe(0);

    // The bot recovers; the SAME session completes again.
    anyBridge.tokenInvalid = false;
    anyBridge.handleSessionEvent("sess-B", completion("恢复后的结论"));
    anyBridge.handleSessionEvent("sess-B", turnEnd());
    await new Promise((r) => setTimeout(r, 150));

    // The notice must be deliverable now. Before the fix the session had been
    // marked "already notified" with no cleanup timer, so this was suppressed
    // permanently.
    expect(sendTextMessage.mock.calls.length).toBeGreaterThan(duringOutage);
  });

  it("the same holds on the bound-session path (second user as recipient)", async () => {
    // The two notice sites are separate code paths. The inline loop runs when
    // the finishing session IS bound to a user (so `userForAgent` resolves)
    // while ANOTHER user is a recipient — a two-user shape. Single-user
    // deployments only ever take the `notifyCrossSessionTurnEnd` path above,
    // so this guards the branch that would otherwise go untested.
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, true);
    const anyBridge = bridge as unknown as AnyBridge;

    // u1 owns sess-B; u2 watches it and is therefore the recipient.
    anyBridge.state.ensureUser("u1", "C:\\work");
    (anyBridge.state as unknown as { update(u: string, p: unknown): void }).update("u1", { sessionId: "sess-B" });
    anyBridge.state.ensureUser("u2", "C:\\work");
    (anyBridge.state as unknown as { watchSession(u: string, s: string): void }).watchSession("u2", "sess-B");
    anyBridge.tokenInvalid = true;

    let seq = 0;
    const completion = (text: string) => ({
      type: "assistant/message",
      seq: seq++,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text }] } },
    });
    const turnEnd = () => ({ type: "turn/end", seq: seq++, time: Date.now(), data: { turn: 1 } });

    anyBridge.handleSessionEvent("sess-B", completion("离线"));
    anyBridge.handleSessionEvent("sess-B", turnEnd());
    await new Promise((r) => setTimeout(r, 150));
    const duringOutage = sendTextMessage.mock.calls.length;
    expect(duringOutage).toBe(0);

    anyBridge.tokenInvalid = false;
    anyBridge.handleSessionEvent("sess-B", completion("恢复"));
    anyBridge.handleSessionEvent("sess-B", turnEnd());
    await new Promise((r) => setTimeout(r, 150));

    // The notice must now EXIST as pending work. It cannot be sent
    // immediately here: the two earlier bodies were parked first and the FIFO
    // forbids overtaking, so "queued" is the correct outcome. Before the fix
    // the session was already marked with no cleanup timer, so the second
    // completion was dropped entirely — neither sent nor queued.
    const queued = anyBridge.outboundCache.some(
      (i) => typeof i.text === "string" && i.text.includes("任务已完成"),
    );
    expect(queued).toBe(true);
  });
});
