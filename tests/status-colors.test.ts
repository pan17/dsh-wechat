/**
 * /status colorization: iLink text items have no <font color> support,
 * so the bridge prepends emoji glyphs (rendered in color by the WeChat
 * client) to draw the reader's eye to actionable rows.
 *
 * Each field has its own polarity:
 *   - 静默模式 on = we stop forwarding → 🔴 warning
 *     静默模式 off = normal delivery     → 🟢 good
 *   - 跨会话通知 on  = extra notifications on → 🟢
 *     跨会话通知 off = off                  → ⚪ neutral
 *   - Agent running      → 🟢 positive
 *     Agent idle         → ⚪ neutral
 *     Agent 未加载       → 🔴 warning
 *   - 权限 danger-*      → 🔴
 *   - 繁忙投递 steer     → 🟢 (interactive)
 *     繁忙投递 queue     → ⚪
 *   - pending cards      → 🔴 prefix on the whole row
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

interface AgentOpts {
  agentStatus?: "idle" | "running" | "none";
  permission?: string;
}

interface BridgeOpts {
  silent?: boolean;
  crossNotify?: boolean;
  busyEnter?: "steer" | "queue";
  agent?: AgentOpts;
}

function makeBridge(opts: BridgeOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-status-color-"));
  const agentOpts = opts.agent ?? {};
  const wantAgent = agentOpts.agentStatus && agentOpts.agentStatus !== "none";
  const liveAgent = wantAgent
    ? {
        id: "wx-1",
        status: agentOpts.agentStatus,
        options: { provider: "x", model: "m" },
        session: { id: "wx-1", header: { agentPreset: "std" } },
        followup: () => {},
        steer: () => {},
        cancel: () => {},
        whenIdle: async () => {},
      }
    : undefined;
  const agentsService = {
    create: async () => ({ agent: liveAgent }),
    resume: async () => ({ agent: liveAgent }),
    get: (id: string) => (liveAgent && id === "wx-1" ? liveAgent : undefined),
    list: () => (liveAgent ? [liveAgent] : []),
  };
  // Settings service drives busyEnter() (ui-conversation namespace).
  const settingsService = {
    get: (_ns: string) => ({ busyEnter: opts.busyEnter ?? "steer" }),
    update: vi.fn().mockResolvedValue(true),
  };
  const permissionService = agentOpts.permission
    ? {
        current: (_events: unknown[]) => agentOpts.permission!,
        names: [agentOpts.permission!],
      }
    : undefined;
  const services: Record<string, unknown> = {
    agents: agentsService,
    settings: settingsService,
    ...(permissionService ? { permissionPresets: permissionService } : {}),
  };
  const ctx = {
    get: (name: string) => services[name],
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  cfg.crossSessionNotify = opts.crossNotify ?? false;
  cfg.silent = opts.silent ?? false;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  const stateApi = bridge as unknown as {
    state: {
      ensureUser(u: string, c: string): unknown;
      update(u: string, p: unknown): void;
    };
  };
  stateApi.state.ensureUser("u1", "C:\\work");
  stateApi.state.update("u1", {
    sessionId: "wx-1",
    silent: opts.silent ?? false,
  });
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://x",
    token: "t",
    accountId: "b1",
    userId: "u",
    savedAt: "",
  };

  return bridge;
}

function wechatTextMessage(text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "ctx-token",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

async function runStatus(bridge: WeChatDSHBridge): Promise<string> {
  sendTextMessage.mockClear();
  await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
    wechatTextMessage("/status"),
  );
  const call = sendTextMessage.mock.calls[0] as [string, string] | undefined;
  if (!call) throw new Error("sendTextMessage was not called");
  return call[1];
}

describe("/status — emoji color markers", () => {
  beforeEach(() => {
    sendTextMessage.mockClear();
  });

  it("静默模式 on (muted) is warning red", async () => {
    const bridge = makeBridge({ silent: true });
    const text = await runStatus(bridge);
    expect(text).toContain("• 静默模式: 🔴 on");
  });

  it("静默模式 off (sending) is good green", async () => {
    const bridge = makeBridge({ silent: false });
    const text = await runStatus(bridge);
    expect(text).toContain("• 静默模式: 🟢 off");
  });

  it("跨会话通知 on is good green", async () => {
    const bridge = makeBridge({ crossNotify: true });
    const text = await runStatus(bridge);
    expect(text).toContain("• 跨会话通知: 🟢 on");
  });

  it("跨会话通知 off is neutral (not a warning state)", async () => {
    const bridge = makeBridge({ crossNotify: false });
    const text = await runStatus(bridge);
    expect(text).toContain("• 跨会话通知: ⚪ off");
  });

  it("微信提示词 on is good green, off is neutral", async () => {
    const off = await runStatus(makeBridge());
    expect(off).toContain("• 微信提示词: ⚪ off");

    const bridge = makeBridge();
    (bridge as unknown as { config: { surfacePromptEnabled: boolean } }).config.surfacePromptEnabled = true;
    const on = await runStatus(bridge);
    expect(on).toContain("• 微信提示词: 🟢 on");
  });

  it("Agent running is green, idle is neutral, missing is red", async () => {
    const running = await runStatus(makeBridge({ agent: { agentStatus: "running" } }));
    expect(running).toContain("• Agent: 🟢 running");

    const idle = await runStatus(makeBridge({ agent: { agentStatus: "idle" } }));
    expect(idle).toContain("• Agent: ⚪ idle");

    const missing = await runStatus(makeBridge({ agent: { agentStatus: "none" } }));
    expect(missing).toContain("• Agent: 🔴 （未加载）");
  });

  it("繁忙投递 steer is green (interactive), queue is neutral", async () => {
    const steer = await runStatus(makeBridge({ busyEnter: "steer" }));
    expect(steer).toContain("• 繁忙投递: 🟢 steer（插话）");

    const queue = await runStatus(makeBridge({ busyEnter: "queue" }));
    expect(queue).toContain("• 繁忙投递: ⚪ queue（排队）");
  });

  it("权限 danger-* is warning red, other permission rows are unprefixed", async () => {
    const danger = await runStatus(
      makeBridge({ agent: { agentStatus: "idle", permission: "danger-full-access" } }),
    );
    expect(danger).toContain("• 权限: 🔴 danger-full-access");

    const safe = await runStatus(
      makeBridge({ agent: { agentStatus: "idle", permission: "safe-read-only" } }),
    );
    expect(safe).toContain("• 权限: safe-read-only");
    expect(safe).not.toContain("🔴 safe-read-only");
  });

  it("pending cards row is prefixed with a red marker", async () => {
    const bridge = makeBridge({ agent: { agentStatus: "idle" } });
    const pending = (bridge as unknown as {
      pendingQuestions: Map<string, Array<{ rpcId: string; sessionId: string; questions: unknown[] }>>;
    }).pendingQuestions;
    pending.set("u1", [
      { rpcId: "q-rpc", sessionId: "wx-1", questions: [{ id: "q1", question: "Continue?", options: [] }] },
    ]);

    const text = await runStatus(bridge);
    expect(text).toContain("🔴 • 待处理: 1 张提问卡");
  });

  it("pending row is omitted when no cards are queued", async () => {
    const text = await runStatus(makeBridge({ agent: { agentStatus: "idle" } }));
    expect(text).not.toContain("待处理");
  });
});