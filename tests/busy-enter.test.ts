/**
 * Busy-Enter delivery behavior (`ui-conversation.busyEnter`) shared with DSH:
 * parser coverage for `/enter`, delivery-mode resolution in forwardToAgent
 * (running × queue/steer × idle), the `/enter` command handler's read/write
 * of the host settings document, and card-bypass/help integration.
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
import {
  parseEnterCommand,
  isBypassSlashCommand,
  formatHelp,
} from "../src/bridge/slash.js";
import { MessageType } from "../src/weixin/types.js";

// ─── Parser ───────────────────────────────────────────────────────────────

describe("parseEnterCommand", () => {
  it("bare /enter and /busy default to status", () => {
    expect(parseEnterCommand("/enter")).toEqual({ kind: "status" });
    expect(parseEnterCommand("/busy")).toEqual({ kind: "status" });
    expect(parseEnterCommand("  /ENTER status ")).toEqual({ kind: "status" });
  });

  it("parses queue aliases", () => {
    expect(parseEnterCommand("/enter queue")).toEqual({ kind: "switch", target: "queue" });
    expect(parseEnterCommand("/enter q")).toEqual({ kind: "switch", target: "queue" });
    expect(parseEnterCommand("/busy 排队")).toEqual({ kind: "switch", target: "queue" });
  });

  it("parses steer aliases", () => {
    expect(parseEnterCommand("/enter steer")).toEqual({ kind: "switch", target: "steer" });
    expect(parseEnterCommand("/enter s")).toEqual({ kind: "switch", target: "steer" });
    expect(parseEnterCommand("/busy 插话")).toEqual({ kind: "switch", target: "steer" });
  });

  it("rejects unknown subcommands and trailing garbage", () => {
    expect(parseEnterCommand("/enter foo")).toBeNull();
    expect(parseEnterCommand("/enter queue extra")).toBeNull();
    expect(parseEnterCommand("/enterstatus")).toBeNull();
    expect(parseEnterCommand("/sessions")).toBeNull();
  });

  it("bypasses pending cards and appears in help", () => {
    expect(isBypassSlashCommand("/enter")).toBe(true);
    expect(isBypassSlashCommand("/enter queue")).toBe(true);
    expect(isBypassSlashCommand("/busy steer")).toBe(true);
    expect(isBypassSlashCommand("/enter bogus")).toBe(false);
    expect(formatHelp()).toContain("/enter (busy)");
  });
});

// ─── Delivery mode resolution ──────────────────────────────────────────────

/** A mock live agent recording followup vs steer deliveries. */
function makeMockAgent(id: string, status: "idle" | "running") {
  const followups: Array<{ id?: string }> = [];
  const steers: Array<{ id?: string }> = [];
  return {
    agent: {
      id,
      status,
      options: {},
      followup: (m: { id?: string }) => followups.push(m),
      steer: (m: { id?: string }) => steers.push(m),
      cancel: () => {},
      whenIdle: async () => {},
    },
    followups,
    steers,
  };
}

function makeBridge(
  agent: ReturnType<typeof makeMockAgent>,
  settings?: { value?: unknown; update: ReturnType<typeof vi.fn> },
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-enter-"));
  const agentsService = {
    create: async () => agent,
    resume: async () => agent,
    get: (id: string) => (id === agent.agent.id ? agent.agent : undefined),
    list: () => [agent.agent],
  };
  const services: Record<string, unknown> = { agents: agentsService };
  if (settings) {
    services.settings = {
      get: (_ns: string) => settings.value,
      update: settings.update,
    };
  }
  const ctx = {
    get: (name: string) => services[name],
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "u",
    savedAt: "",
  };
  (bridge as unknown as { contextTokens: Map<string, string> }).contextTokens.set("u1", "ctx-token");
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

describe("busy-time delivery follows ui-conversation.busyEnter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("running + steer delivers through agent.steer", async () => {
    const mock = makeMockAgent("wx-s1", "running");
    const bridge = makeBridge(mock, { value: { busyEnter: "steer" }, update: vi.fn() });
    await (bridge as unknown as { handleMessage(m: unknown): Promise<void> }).handleMessage(
      wechatTextMessage("插话一下"),
    );
    expect(mock.steers.length).toBe(1);
    expect(mock.followups.length).toBe(0);
    expect(mock.steers[0]!.id).toMatch(/^wx-msg-/);
  });

  it("running + queue keeps the ordinary follow-up turn", async () => {
    const mock = makeMockAgent("wx-s1", "running");
    const bridge = makeBridge(mock, { value: { busyEnter: "queue" }, update: vi.fn() });
    await (bridge as unknown as { handleMessage(m: unknown): Promise<void> }).handleMessage(
      wechatTextMessage("排队说话"),
    );
    expect(mock.followups.length).toBe(1);
    expect(mock.steers.length).toBe(0);
  });

  it("idle always queues even when the preference is steer", async () => {
    const mock = makeMockAgent("wx-s1", "idle");
    const bridge = makeBridge(mock, { value: { busyEnter: "steer" }, update: vi.fn() });
    await (bridge as unknown as { handleMessage(m: unknown): Promise<void> }).handleMessage(
      wechatTextMessage("正常开新轮"),
    );
    expect(mock.followups.length).toBe(1);
    expect(mock.steers.length).toBe(0);
  });

  it("missing settings service degrades to queue", async () => {
    const mock = makeMockAgent("wx-s1", "running");
    const bridge = makeBridge(mock);
    await (bridge as unknown as { handleMessage(m: unknown): Promise<void> }).handleMessage(
      wechatTextMessage("没有设置服务"),
    );
    expect(mock.followups.length).toBe(1);
    expect(mock.steers.length).toBe(0);
  });
});

// ─── /enter command handler ───────────────────────────────────────────────

describe("/enter command handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("status reports the resolved behavior", async () => {
    const mock = makeMockAgent("wx-s1", "idle");
    const bridge = makeBridge(mock, { value: { busyEnter: "steer" }, update: vi.fn() });
    await (bridge as unknown as {
      handleEnterCommand(u: string, c: unknown): Promise<void>;
    }).handleEnterCommand("u1", { kind: "status" });
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("steer");
    expect(text).toContain("繁忙时投递");
  });

  it("switch writes the shared DSH settings document", async () => {
    const mock = makeMockAgent("wx-s1", "idle");
    const update = vi.fn().mockResolvedValue(undefined);
    const bridge = makeBridge(mock, { value: { busyEnter: "queue" }, update });
    await (bridge as unknown as {
      handleEnterCommand(u: string, c: unknown): Promise<void>;
    }).handleEnterCommand("u1", { kind: "switch", target: "steer" });
    expect(update).toHaveBeenCalledWith("ui-conversation", { busyEnter: "steer" });
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("✅");
    expect(text).toContain("GUI 设置页同步可见");
  });

  it("switch without a settings service reports degradation", async () => {
    const mock = makeMockAgent("wx-s1", "idle");
    const bridge = makeBridge(mock);
    await (bridge as unknown as {
      handleEnterCommand(u: string, c: unknown): Promise<void>;
    }).handleEnterCommand("u1", { kind: "switch", target: "queue" });
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("⚠️ 无法写入 DSH 设置");
  });
});
