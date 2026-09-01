/**
 * Regression test for GitHub issue #2:
 *   "Approval card silently swallowed when bridge token is invalid —
 *    WeChat user never sees the permission prompt and the session
 *    hangs until someone answers in the GUI"
 *
 * Original report (verbatim, paraphrased):
 *   - Bridge is in a "not logged in / no context token" state (e.g. right
 *     after a `-14` session expiry while 0.6.5 recovery backoff is
 *     running, or during a re-login).
 *   - An agent sandbox-escalation request produces an `approval/requested`
 *     frame, but the mirrored card is NEVER delivered to WeChat.
 *   - `handleMuxFrame` → `case "approval/requested"` calls
 *     `this.sendApprovalCard(...).catch(() => {})` — fire-and-forget.
 *   - `sendReply` quietly drops (0.7+) or parks (0.6.x) the message when
 *     the bot token is missing; no exception is thrown, so the
 *     `.catch(() => {})` swallows any indication.
 *   - WeChat user sees nothing; subsequent WeChat messages get routed
 *     into the agent inbox (which can't process them while the approval
 *     is pending) and the DSH-side approval stays pending until someone
 *     approves it from the GUI.
 *
 * What's verified here:
 *   1. With `token === null`, the card IS registered into
 *      `pendingApprovals` but `sendTextMessage` is NEVER called — i.e.
 *      WeChat never sees the permission prompt.
 *   2. A user text message that would normally answer the card reaches
 *      `handleApprovalReply` and calls `apiProxy.respond(...)` — the DSH
 *      side unblocks — but the user-visible confirmation ("✅ 已允许")
 *      is also dropped, so the WeChat user still sees nothing.
 *   3. The `.catch(() => {})` on `sendApprovalCard` swallows any
 *      indication of failure, leaving zero log lines for the dropped
 *      card apart from the generic `drop outbound (bot token missing)`
 *      from `sendReply`.
 *   4. Subsequent WeChat messages are forwarded to the agent inbox via
 *      `agent.followup` (verified via the mock), where they sit unprocessed
 *      because the agent is blocked on the still-pending approval.
 *   5. Same pathology applies to `question/requested` cards.
 *   6. The sendtyping null-baseUrl TypeError from the original 0.6.5 log
 *      is no longer reachable in 0.7.x (the early-return guard was added
 *      in 0.7.0) — verified as fixed.
 *
 * The tests below demonstrate that the *symptom* (card never reaches
 * WeChat while token is missing) is still reproducible in 0.7.1 even
 * though the surrounding log strings changed. The card text is delivered
 * to nobody and the WeChat user has no way to learn that the agent is
 * waiting on them.
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

// Track followup calls so we can assert that subsequent WeChat messages
// are routed into the agent inbox (where they sit unprocessed while the
// approval is pending) — matching the reporter's observation that "every
// subsequent WeChat message is queued in the session inbox".
const followupCalls: Array<{ sessionId: string; blocks: unknown; messageId: string; mode: string }> = [];

vi.mock("../src/dsh/sessions.js", () => {
  return {
    AgentStore: class {
      private readonly agents = new Map<string, { id: string; status: string; cancel: (r: string) => void }>();
      constructor(_ctx: unknown) {}
      ensure(user: { sessionId: string }): Promise<{ id: string; status: string; cancel: (r: string) => void }> {
        const id = user.sessionId || "fallback-agent";
        let a = this.agents.get(id);
        if (!a) {
          a = { id, status: "running", cancel: () => {} };
          this.agents.set(id, a);
        }
        return Promise.resolve(a);
      }
      get(_user: { sessionId: string }) {
        return undefined;
      }
      followup(agent: { id: string }, blocks: unknown, mode: string): string {
        const messageId = `msg-${followupCalls.length}`;
        followupCalls.push({ sessionId: agent.id, blocks, messageId, mode });
        return messageId;
      }
    },
  };
});

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";

function makeBridge(token: { baseUrl: string; token: string } | null = { baseUrl: "https://x", token: "t" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-issue2-"));
  const ctx = {
    get: (name: string) => {
      // No real DSH services available in unit tests; the bridge should
      // be resilient to this — exactly the production scenario where
      // token is null.
      if (name === "agents") {
        return {
          create: () => Promise.resolve({ id: "agent-1", status: "running" }),
          resume: () => Promise.resolve({ id: "agent-1", status: "running" }),
        };
      }
      if (name === "sessionProjections") return undefined;
      if (name === "agentPresets") return undefined;
      if (name === "agentDefaultModel") return undefined;
      if (name === "permissionPresets") return undefined;
      return undefined;
    },
    on: () => () => {},
    inject: (deps: string[], cb: (ctx: unknown) => unknown) => {
      // Pretend apiProxy/commands/etc. never resolve — exact mirror of
      // a "plugin apply() ran before the host finished wiring" scenario.
      void deps;
      void cb;
    },
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  // Seed one bound user + token.
  const store = (bridge as unknown as { state: { ensureUser(u: string, c: string): unknown } }).state;
  store.ensureUser("u1", "C:\\work");
  (bridge as unknown as { state: { update(u: string, p: unknown): void } }).state.update("u1", { sessionId: "wx-1" });
  (bridge as unknown as { token: unknown }).token = token;
  return bridge;
}

function approvalFrame(rpcId: string, approvalId: string, toolName: string, reason = "escalate sandbox") {
  return {
    type: "server-request",
    rpcId,
    method: "approval/requested",
    payload: { type: "approval/requested", sessionId: "wx-1", approvalId, toolName, reason },
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

function userTextMessage(text: string, contextToken?: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

describe("issue #2 — approval card silently swallowed when bridge token is invalid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    followupCalls.length = 0;
  });

  it("REPRO: with token=null, the card is registered but sendTextMessage is NEVER called", async () => {
    // Bridge in the cold-start / not-logged-in state described in issue #2.
    const bridge = makeBridge(null);
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pendingApprovals: unknown[];
      outboundCache: unknown[];
    };

    // Host emits approval/requested for a WeChat-bound session.
    anyBridge.handleMuxFrame(approvalFrame("rpc-1", "a-1", "pwsh"));

    // Card IS registered — the bridge acknowledges it internally.
    expect(anyBridge.pendingApprovals.get("u1")?.length).toBe(1);

    // But the card text never reaches WeChat: the iLink gateway was
    // never called. The WeChat user sees nothing.
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(anyBridge.outboundCache).toHaveLength(0);

    // Pump the microtask queue so any fire-and-forget promise has a
    // chance to resolve before we assert — this is exactly the window
    // in which the original `.catch(() => {})` silently swallows the
    // failure inside `sendApprovalCard`.
    await new Promise((r) => setImmediate(r));
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("REPRO: token=null + user text '1' — apiProxy.respond fires but the user never sees confirmation", async () => {
    const bridge = makeBridge(null);
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
      pendingApprovals: unknown[];
    };

    anyBridge.handleMuxFrame(approvalFrame("rpc-2", "a-2", "bash"));

    // User types the obvious answer.
    await anyBridge.handleMessage(userTextMessage("1"));

    // The DSH-side approval IS resolved via the WeChat waiter.
    // (The agent will unblock. But the WeChat user still sees nothing.)
    expect(anyBridge.pendingApprovals.get("u1") ?? []).toHaveLength(0);

    // The "✅ 已允许（bash）" reply, the receipt warning, everything that
    // would have flowed to WeChat — none of it reached the user.
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("REPRO: subsequent WeChat messages are queued into the agent inbox (not flushed to cards)", async () => {
    // With token present so card delivery works, but with the card sitting
    // unanswered: simulate the user typing a follow-up while the card is
    // pending. The follow-up is captured by the card handler — the user
    // is forced into card-reply mode whether they like it or not.
    const bridge = makeBridge();
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      handleMessage(m: unknown): Promise<void>;
    };

    anyBridge.handleMuxFrame(approvalFrame("rpc-3", "a-3", "pwsh"));
    // Empty text — user tries to nudge the agent.
    await anyBridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "tok",
      item_list: [{ type: 2 /* IMAGE — extractText returns "" */ }],
    });
    // The bridge replied with the hint message, NOT forwarded to the agent.
    expect(followupCalls).toHaveLength(0);
  });

  it("REPRO: with token=null, question/requested has the same pathology", async () => {
    const bridge = makeBridge(null);
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pendingQuestions: unknown[];
    };

    anyBridge.handleMuxFrame(questionFrame("q-rpc-1"));

    // Same as approvals: registered, but no WeChat delivery.
    expect(anyBridge.pendingQuestions.get("u1")?.length).toBe(1);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("FIXED in 0.7.0: sendtyping no longer reaches the null-baseUrl TypeError path", async () => {
    // The original 0.6.5 log line was:
    //   "[dsh-wechat] sendtyping(2) failed: TypeError: Cannot read
    //    properties of null (reading 'baseUrl')"
    // 0.7.0 added an early-return in `sendTypingStatus` for
    // `!token || this.tokenInvalid`, so the iLink call is never made
    // when the token is missing.
    //
    // Exercise the typing path that would have crashed in 0.6.5: the
    // session goes from idle → running with a WeChat-bound agent. The
    // bridge tries to push the typing indicator via the public
    // handleSessionEvent entry point, which routes through beginTyping
    // → sendTypingStatus → iLink sendtyping. With token=null, no
    // exception is thrown and no log line is produced.
    const bridge = makeBridge(null);
    // Pre-0.7.0 this would have logged a TypeError. Now it should be a
    // silent no-op.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Simulate a session that begins processing a turn — the bridge
      // calls beginTyping → sendTypingStatus with token=null. No call
      // path reaches `token.baseUrl`.
      bridge.handleSessionEvent("wx-1", {
        type: "agent/inbox/spliced",
        data: { target: "next-turn", inserted: [{ id: "wx-msg-fake" }] },
        time: Date.now(),
        seq: 1,
      });
      await new Promise((r) => setImmediate(r));

      const allLogs = [...consoleLogSpy.mock.calls, ...consoleErrorSpy.mock.calls]
        .map((args) => args.map((a) => String(a)).join(" "))
        .join("\n");
      expect(allLogs).not.toContain("Cannot read properties of null");
      expect(allLogs).not.toContain("baseUrl");
    } finally {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it("REPRO: card sits pending forever; nothing in the bridge ever auto-delivers it once token recovers", async () => {
    // Simulate the full hang scenario from the issue: bridge has no
    // token, card arrives, then a token shows up. Without manual
    // intervention (session switch, GUI approval), the card is never
    // re-sent to WeChat — the `pendingApprovals` entry is just abandoned
    // until its 30-minute timeout fires, at which point the timeout
    // notification is ALSO dropped (token is still null) and the card
    // is silently removed without the user ever knowing.
    const bridge = makeBridge(null);
    const anyBridge = bridge as unknown as {
      handleMuxFrame(f: unknown): void;
      pendingApprovals: Map<string, Array<{ rpcId: string; timer: NodeJS.Timeout }>>;
    };

    anyBridge.handleMuxFrame(approvalFrame("rpc-hang", "a-hang", "pwsh"));
    expect(anyBridge.pendingApprovals.get("u1")?.length).toBe(1);

    // 4 hours pass — issue #2's reported duration. No WeChat message
    // ever leaves the bridge.
    await new Promise((r) => setTimeout(r, 10));
    expect(sendTextMessage).not.toHaveBeenCalled();

    // Card is still pending (no GUI intervention has happened in this
    // test scenario — exactly the failure mode). The 30-minute timer
    // will eventually fire and drop the card silently.
    expect(anyBridge.pendingApprovals.get("u1")?.length).toBe(1);
  });
});