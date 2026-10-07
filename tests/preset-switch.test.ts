import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DshOps } from "../src/dsh/ops.js";
import { AgentStore } from "../src/dsh/sessions.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";

const { sendTextMessage } = vi.hoisted(() => ({ sendTextMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage,
  sendMediaMessage: vi.fn(),
  splitText: (text: string) => [text],
}));
import { WeChatDSHBridge } from "../src/bridge/bridge.js";

function context(services: Record<string, unknown>) {
  return { get: (name: string) => services[name], on: () => () => {} };
}

const temporaryDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  sendTextMessage.mockClear();
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("default Preset settings compatibility", () => {
  it.each(["agent-preset-registry", "include:agent-preset-registry"])(
    "writes selectedDefault to the advertised %s namespace",
    async (ns) => {
      let selectedDefault = "standard";
      const settings = {
        describe: () => [{ ns, value: { selectedDefault } }],
        update: vi.fn(async (namespace: string, patch: { selectedDefault: string }) => {
          if (namespace !== ns || Object.keys(patch).join() !== "selectedDefault") {
            throw new Error("Invalid settings target");
          }
          selectedDefault = patch.selectedDefault;
        }),
      };
      const services = {
        settings,
        agentPresets: { get defaultId() { return selectedDefault; } },
        agents: { create: vi.fn(async () => ({ agent: { id: "new-session" } })) },
      };
      const ctx = context(services);
      const ops = new DshOps(ctx);
      await expect(ops.saveDefaultPreset("cordis")).resolves.toBe(true);
      expect(settings.update).toHaveBeenCalledWith(ns, { selectedDefault: "cordis" });
      expect(ops.defaultPresetId()).toBe("cordis");
      const store = new AgentStore(ctx);
      await store.ensure({ userId: "u1", sessionId: "", cwd: "C:\\work" });
      expect(services.agents.create).toHaveBeenCalledWith(expect.objectContaining({
        meta: { cwd: "C:\\work", agentPreset: "cordis" },
      }));
    },
  );

  it("keeps the legacy agent-presets.default document contract", async () => {
    for (const describe of [undefined, () => [{ ns: "agent-presets" }]]) {
      const update = vi.fn().mockResolvedValue(undefined);
      const ops = new DshOps(context({ settings: { describe, update } }));
      await expect(ops.saveDefaultPreset("cordis")).resolves.toBe(true);
      expect(update).toHaveBeenCalledWith("agent-presets", { default: "cordis" });
    }
  });

  it("does not write an unregistered namespace", async () => {
    const update = vi.fn();
    const ops = new DshOps(context({ settings: { describe: () => [], update } }));
    await expect(ops.saveDefaultPreset("cordis")).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("reports a rejected write without changing the default", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ops = new DshOps(context({
      settings: {
        describe: () => [{ ns: "agent-preset-registry" }],
        update: vi.fn().mockRejectedValue(new Error("Write refused")),
      },
      agentPresets: { defaultId: "standard" },
    }));
    await expect(ops.saveDefaultPreset("cordis")).resolves.toBe(false);
    expect(ops.defaultPresetId()).toBe("standard");
  });

  it("reports missing settings as a failure", async () => {
    await expect(new DshOps(context({})).saveDefaultPreset("cordis")).resolves.toBe(false);
  });
});

function makeBridge(options: { empty: boolean; rejectWrite?: boolean; missingSettings?: boolean }) {
  let selectedDefault = "standard";
  const recompose = vi.fn().mockResolvedValue(undefined);
  const settings = {
    describe: () => [{ ns: "agent-preset-registry", value: { selectedDefault } }],
    update: vi.fn(async (_ns: string, patch: { selectedDefault: string }) => {
      if (options.rejectWrite) throw new Error("Write refused");
      selectedDefault = patch.selectedDefault;
    }),
  };
  const agent = {
    id: "s-live", status: "idle", ctx: {},
    session: { snapshotEvents: () => options.empty ? [] : [{ type: "user/message" }] },
  };
  const presets = {
    list: async () => [{ id: "standard" }, { id: "cordis" }],
    get defaultId() { return selectedDefault; },
    recompose,
  };
  const ctx = context({
    agentPresets: presets,
    agents: { get: (id: string) => id === agent.id ? agent : undefined },
    ...(!options.missingSettings ? { settings } : {}),
  });
  const cfg = defaultConfig();
  cfg.storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-preset-switch-"));
  temporaryDirs.push(cfg.storageDir);
  const bridge = new WeChatDSHBridge(ctx, cfg);
  const harness = bridge as unknown as {
    token: unknown;
    state: { ensureUser(userId: string, cwd: string): unknown; update(userId: string, patch: unknown): void };
    handleMessage(message: unknown): Promise<void>;
  };
  harness.token = { baseUrl: "https://gw", token: "t", accountId: "b1", userId: "u", savedAt: "" };
  harness.state.ensureUser("u1", "C:\\work");
  harness.state.update("u1", { sessionId: agent.id });
  return { harness, settings, recompose, presets, agent };
}

async function switchPreset(harness: { handleMessage(message: unknown): Promise<void> }) {
  await harness.handleMessage({
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "ctx-token",
    item_list: [{ type: 1, text_item: { text: "/preset switch cordis" } }],
  });
  return sendTextMessage.mock.calls.map((call) => String(call[1])).join("\n");
}

describe("WeChat /preset switch replies", () => {
  it("saves the default and leaves an existing conversation on its current Preset", async () => {
    const { harness, settings, recompose, presets } = makeBridge({ empty: false });
    const reply = await switchPreset(harness);
    expect(settings.update).toHaveBeenCalledWith("agent-preset-registry", { selectedDefault: "cordis" });
    expect(presets.defaultId).toBe("cordis");
    expect(recompose).not.toHaveBeenCalled();
    expect(reply).toContain("✅ 默认 Preset 已切换: cordis");
    expect(reply).toContain("Preset 将应用于下一个新会话");
    expect(reply).not.toContain("无法写入");
  });

  it("applies the saved default to a blank live session", async () => {
    const { harness, recompose, agent } = makeBridge({ empty: true });
    expect(await switchPreset(harness)).toContain("已应用到当前会话");
    expect(recompose).toHaveBeenCalledWith(agent.ctx, "cordis");
  });

  it.each(["rejected", "missing"])("does not claim success or recompose when settings are %s", async (reason) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { harness, recompose, presets } = makeBridge({
      empty: true,
      rejectWrite: reason === "rejected",
      missingSettings: reason === "missing",
    });
    const reply = await switchPreset(harness);
    expect(reply).toContain("默认 Preset 切换失败");
    expect(reply).toContain("默认 Preset 未更改");
    expect(reply).not.toContain("✅");
    expect(reply).not.toContain("仅本次进程内生效");
    expect(presets.defaultId).toBe("standard");
    expect(recompose).not.toHaveBeenCalled();
  });
});
