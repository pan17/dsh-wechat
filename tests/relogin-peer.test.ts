/**
 * After logout / re-scan, a different WeChat account must be allowed to
 * become the single peer. Previously the old `from_user_id` stayed locked
 * in memory and `state.json`, so the new account's inbound was dropped:
 *   ignore inbound from <new> (single-user peer is <old>)
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

vi.mock("../src/weixin/monitor.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/weixin/monitor.js")>();
  return {
    ...orig,
    startMonitor: vi.fn(async () => {}),
  };
});

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";
import { ConfigStore } from "../src/config-store.js";
import { StateStore } from "../src/state.js";
import { MessageType } from "../src/weixin/types.js";
import { clearSyncBuf } from "../src/weixin/monitor.js";

function makeMockAgent(id: string) {
  const received: Array<{ content: unknown }> = [];
  return {
    agent: {
      id,
      status: "idle",
      options: { provider: "deepseek", model: "deepseek-chat" },
      followup: (m: { content: unknown }) => received.push(m),
      steer: () => {},
      cancel: () => {},
      whenIdle: async () => {},
    },
    received,
  };
}

function makeBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-relogin-"));
  const mock = makeMockAgent("wx-s1");
  const agentsService = {
    create: async () => mock,
    resume: async () => mock,
    get: (id: string) => (id === mock.agent.id ? mock.agent : undefined),
    list: () => [mock.agent],
  };
  const ctx = {
    get: (name: string) => (name === "agents" ? agentsService : undefined),
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
  return { bridge, mock, storageDir: dir };
}

function wechatText(from: string, text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: from,
    context_token: `ctx-${from}`,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

type BridgeHarness = {
  handleMessage(m: unknown): Promise<void>;
  logout(): Promise<{ ok: boolean; message: string }>;
  relogin(): Promise<{ ok: boolean; message: string }>;
  start(): Promise<void>;
  reconnect(): Promise<{ ok: boolean; message: string }>;
  startLoginFlow(): Promise<void>;
  peerUserId: string | null;
  wireContextToken: string | null;
  state: { all(): Array<{ userId: string }>; ensureUser(u: string, c: string): unknown };
};

describe("relogin / logout unlocks the single-user peer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logout forgets the old WeChat user so a new account is accepted", async () => {
    const { bridge, mock } = makeBridge();
    const anyBridge = bridge as unknown as BridgeHarness;

    await anyBridge.handleMessage(wechatText("old-user", "先到先得"));
    expect(anyBridge.peerUserId).toBe("old-user");
    expect(mock.received.length).toBe(1);

    await anyBridge.logout();
    expect(anyBridge.peerUserId).toBeNull();
    expect(anyBridge.wireContextToken).toBeNull();
    expect(anyBridge.state.all()).toEqual([]);

    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw",
      token: "t2",
      accountId: "b2",
      userId: "u",
      savedAt: "",
    };
    await anyBridge.handleMessage(wechatText("new-user", "换号后来的"));
    expect(anyBridge.peerUserId).toBe("new-user");
    expect(anyBridge.wireContextToken).toBe("ctx-new-user");
    expect(mock.received.length).toBe(2);
  });

  it("relogin forgets the old peer without waiting for login to finish", async () => {
    const { bridge, mock, storageDir } = makeBridge();
    const anyBridge = bridge as unknown as BridgeHarness;
    anyBridge.startLoginFlow = async () => {};

    await anyBridge.handleMessage(wechatText("old-user", "旧号"));
    fs.writeFileSync(
      path.join(storageDir, "sync-buf.json"),
      JSON.stringify({ get_updates_buf: "old-cursor" }),
      "utf-8",
    );

    await anyBridge.relogin();
    expect(anyBridge.peerUserId).toBeNull();
    expect(anyBridge.state.all()).toEqual([]);
    expect(fs.existsSync(path.join(storageDir, "sync-buf.json"))).toBe(false);

    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw",
      token: "t2",
      accountId: "b2",
      userId: "u",
      savedAt: "",
    };
    await anyBridge.handleMessage(wechatText("new-user", "新号"));
    expect(anyBridge.peerUserId).toBe("new-user");
    expect(mock.received.length).toBe(2);
  });

  it("start without a bot token does not re-lock the previous peer from state.json", async () => {
    const { bridge, mock, storageDir } = makeBridge();
    const anyBridge = bridge as unknown as BridgeHarness;
    anyBridge.startLoginFlow = async () => {};
    anyBridge.state.ensureUser("old-user", "C:\\work");
    (bridge as unknown as { token: unknown }).token = null;

    await anyBridge.start();
    expect(anyBridge.peerUserId).toBeNull();
    expect(anyBridge.state.all()).toEqual([]);
    expect(new StateStore(storageDir).all()).toEqual([]);

    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw",
      token: "t2",
      accountId: "b2",
      userId: "u",
      savedAt: "",
    };
    await anyBridge.handleMessage(wechatText("new-user", "重启后新号"));
    expect(anyBridge.peerUserId).toBe("new-user");
    expect(mock.received.length).toBe(1);
  });

  it("reconnect with a live token keeps the existing peer", async () => {
    const { bridge, mock, storageDir } = makeBridge();
    const anyBridge = bridge as unknown as BridgeHarness;
    fs.mkdirSync(path.join(storageDir, "auth"), { recursive: true });
    fs.writeFileSync(path.join(storageDir, "auth", "token.json"), JSON.stringify({
      token: "t",
      baseUrl: "https://gw",
      accountId: "b1",
      userId: "u",
      savedAt: "",
    }), "utf-8");
    await anyBridge.handleMessage(wechatText("old-user", "还是我"));
    await anyBridge.reconnect();
    expect(anyBridge.peerUserId).toBe("old-user");
    expect(anyBridge.state.all().map((u) => u.userId)).toEqual(["old-user"]);

    await anyBridge.handleMessage(wechatText("new-user", "别人"));
    expect(mock.received.length).toBe(1);
    expect(anyBridge.peerUserId).toBe("old-user");
  });
});

describe("silent mode survives relogin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeStoredBridge() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-silent-"));
    const mock = makeMockAgent("wx-s1");
    const agentsService = {
      create: async () => mock,
      resume: async () => mock,
      get: (id: string) => (id === mock.agent.id ? mock.agent : undefined),
      list: () => [mock.agent],
    };
    const ctx = {
      get: (name: string) => (name === "agents" ? agentsService : undefined),
      on: () => () => {},
    };
    const store = new ConfigStore(dir);
    const cfg = store.resolve(defaultConfig());
    cfg.storageDir = dir;
    const bridge = new WeChatDSHBridge(ctx, cfg, undefined, store);
    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw",
      token: "t",
      accountId: "b1",
      userId: "u",
      savedAt: "",
    };
    return { bridge, mock, storageDir: dir, store };
  }

  it("saves silent with no bound user and keeps it after relogin", async () => {
    const { bridge } = makeStoredBridge();
    const anyBridge = bridge as unknown as BridgeHarness & {
      updateConfig(patch: { silent?: boolean }): Promise<{ config: Record<string, unknown> }>;
      getStatus(): { config?: { silent?: boolean }; users: Array<{ silent?: boolean }> };
    };
    anyBridge.startLoginFlow = async () => {};

    const saved = await anyBridge.updateConfig({ silent: true });
    expect(saved.config.silent).toBe(true);
    expect(anyBridge.getStatus().config?.silent).toBe(true);
    expect(anyBridge.getStatus().users).toEqual([]);

    await anyBridge.relogin();
    expect(anyBridge.state.all()).toEqual([]);
    expect(anyBridge.getStatus().config?.silent).toBe(true);

    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw",
      token: "t2",
      accountId: "b2",
      userId: "u",
      savedAt: "",
    };
    await anyBridge.handleMessage(wechatText("new-user", "你好"));
    expect(anyBridge.state.all()[0]?.userId).toBe("new-user");
    expect(anyBridge.state.all()[0]).toMatchObject({ silent: true });
    expect(anyBridge.getStatus().users[0]?.silent).toBe(true);
  });

  it("migrates a legacy per-user silent flag into config.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-silent-mig-"));
    try {
      const state = new StateStore(dir);
      state.ensureUser("old-user", "C:\\work");
      state.update("old-user", { silent: true });

      const store = new ConfigStore(dir);
      const cfg = store.resolve(defaultConfig());
      cfg.storageDir = dir;
      const ctx = { get: () => undefined, on: () => () => {} };
      const bridge = new WeChatDSHBridge(ctx, cfg, undefined, store);
      expect((bridge as unknown as { config: { silent: boolean } }).config.silent).toBe(true);
      expect(new ConfigStore(dir).stored().silent).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("clearSyncBuf", () => {
  it("deletes the long-poll cursor file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-sync-"));
    try {
      fs.writeFileSync(path.join(dir, "sync-buf.json"), JSON.stringify({ get_updates_buf: "abc" }), "utf-8");
      clearSyncBuf(dir);
      expect(fs.existsSync(path.join(dir, "sync-buf.json"))).toBe(false);
      clearSyncBuf(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
