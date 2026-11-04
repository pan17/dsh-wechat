/**
 * 工作步骤展示 (`workSteps`) — config migration, `/steps`, and the one-line
 * `/status` row. The delivery behavior itself lives in `final-only.test.ts`
 * (极简 per-task hold) and `process-forwarding.test.ts` (简洁 vs 标准).
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
import {
  defaultConfig,
  normalizeWorkSteps,
  normalizeWorkStepsConfig,
} from "../src/config.js";
import { ConfigStore } from "../src/config-store.js";
import {
  detectUnknownSlashCommand,
  isBypassSlashCommand,
  isMistypedLocalCommand,
  parseWorkStepsCommand,
} from "../src/bridge/slash.js";
import { MessageType } from "../src/weixin/types.js";

const live: any[] = [];
const IDLE_MS = 20;

function makeBridge(patch: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-steps-"));
  const store = new ConfigStore(dir);
  const cfg = store.resolve(defaultConfig());
  cfg.storageDir = dir;
  cfg.finalOnlyIdleMs = IDLE_MS;
  cfg.finalOnlyCeilingMs = 60_000;
  Object.assign(cfg, patch);
  const ctx: any = {
    get: (name: string) => {
      if (name === "workspaceRegistry") {
        return { list: () => [], archivedSessionIds: [] };
      }
      if (name === "sessionQuery") {
        return {
          listSessions: async () => [
            { header: { id: "sess-A", cwd: "C:\\work", createdAt: Date.now() }, live: true, persisted: true },
          ],
          readTitle: async () => ({ title: "当前会话" }),
          listEvents: async () => [],
        };
      }
      return undefined;
    },
    on: () => () => {},
  };
  const bridge = new WeChatDSHBridge(ctx, cfg, undefined, store);
  const state: any = (bridge as any).state;
  state.ensureUser("u1", "C:\\work");
  state.update("u1", { sessionId: "sess-A" });
  (bridge as any).token = { baseUrl: "https://x", token: "t" };
  (bridge as any).ops.readSessionTitle = async () => "当前会话";
  live.push(bridge);
  return { bridge: bridge as any, dir, store };
}

const send = (bridge: any, text: string) =>
  bridge.handleMessage({
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "ct",
    item_list: [{ type: 1, text_item: { text } }],
  } as any);

const texts = () => sendTextMessage.mock.calls.map((c: any) => c[1] as string);
const flushTicks = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const goalRound = (bridge: any, round: number, text: string) => {
  bridge.handleSessionEvent("sess-A", {
    type: "user/message",
    time: Date.now(),
    data: { source: { kind: "goal", goalId: "g1", revision: 1, round } },
  });
  bridge.handleSessionEvent("sess-A", {
    type: "assistant/message",
    time: Date.now(),
    data: { message: { content: [{ type: "text", text }] } },
  });
  bridge.handleSessionEvent("sess-A", {
    type: "turn/end",
    time: Date.now(),
    data: { turn: 1, reason: { kind: "completed" } },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const bridge of live.splice(0)) {
    await bridge.stop().catch(() => {});
  }
  await flushTicks();
});

describe("workSteps config", () => {
  it("defaults to standard and keeps the minimal timings", () => {
    const cfg = defaultConfig();
    expect(cfg.workSteps).toBe("standard");
    expect(cfg.finalOnlyIdleMs).toBe(45_000);
    expect(cfg.finalOnlyCeilingMs).toBe(600_000);
  });

  it("narrows only the three documented values", () => {
    expect(normalizeWorkSteps("minimal")).toBe("minimal");
    expect(normalizeWorkSteps("concise")).toBe("concise");
    expect(normalizeWorkSteps("standard")).toBe("standard");
    expect(normalizeWorkSteps("silent")).toBeUndefined();
    expect(normalizeWorkSteps("")).toBeUndefined();
    expect(normalizeWorkSteps(undefined)).toBeUndefined();
  });

  it("folds the old booleans into workSteps and deletes them", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ finalOnly: true }, "minimal"],
      [{ silent: true }, "concise"],
      [{ silent: true, finalOnly: true }, "minimal"],
      [{ silent: false, finalOnly: false }, "standard"],
      [{ silent: false }, "standard"],
      [{ workSteps: "concise", finalOnly: true }, "concise"],
      [{ workSteps: "junk", silent: true }, "concise"],
      [{ workSteps: "junk" }, "undefined"],
    ];
    for (const [raw, expected] of cases) {
      normalizeWorkStepsConfig(raw);
      expect(raw.workSteps ?? "undefined").toBe(expected);
      expect(raw.silent).toBeUndefined();
      expect(raw.finalOnly).toBeUndefined();
    }
  });

  it("persists workSteps through the store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-steps-store-"));
    try {
      const store = new ConfigStore(dir);
      expect(store.update({ workSteps: "minimal" }).workSteps).toBe("minimal");
      expect(new ConfigStore(dir).stored().workSteps).toBe("minimal");
      expect(store.update({ workSteps: "verbose" as never }).workSteps).toBe("minimal");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/steps parser", () => {
  it("parses status and all three modes in Chinese and English", () => {
    expect(parseWorkStepsCommand("/steps")).toEqual({ kind: "steps", mode: "status" });
    expect(parseWorkStepsCommand("/steps status")).toEqual({ kind: "steps", mode: "status" });
    expect(parseWorkStepsCommand("/steps 极简")).toEqual({ kind: "steps", mode: "minimal" });
    expect(parseWorkStepsCommand("/steps 简洁")).toEqual({ kind: "steps", mode: "concise" });
    expect(parseWorkStepsCommand("/steps 标准")).toEqual({ kind: "steps", mode: "standard" });
    expect(parseWorkStepsCommand("  /Steps  MINIMAL ")).toEqual({ kind: "steps", mode: "minimal" });
    expect(parseWorkStepsCommand("/steps concise")).toEqual({ kind: "steps", mode: "concise" });
    expect(parseWorkStepsCommand("/steps standard")).toEqual({ kind: "steps", mode: "standard" });
  });

  it("refuses an unknown argument and the removed command names", () => {
    expect(parseWorkStepsCommand("/steps maybe")).toBeNull();
    expect(parseWorkStepsCommand("/step")).toBeNull();
    expect(parseWorkStepsCommand("/stepsfoo")).toBeNull();
    expect(parseWorkStepsCommand("/steps constructor")).toBeNull();
    expect(parseWorkStepsCommand("/steps __proto__")).toBeNull();
    expect(parseWorkStepsCommand("/silent on")).toBeNull();
    expect(parseWorkStepsCommand("/final on")).toBeNull();
  });

  it("owns the name, bypasses cards, and no longer owns the old names", () => {
    expect(isBypassSlashCommand("/steps")).toBe(true);
    expect(isBypassSlashCommand("/steps 极简")).toBe(true);
    expect(isMistypedLocalCommand("/steps onn")).toBe(true);
    expect(isMistypedLocalCommand("/steps maybe")).toBe(true);
    expect(isBypassSlashCommand("/silent on")).toBe(false);
    expect(isBypassSlashCommand("/final on")).toBe(false);
    expect(isMistypedLocalCommand("/silent on")).toBe(false);
    expect(isMistypedLocalCommand("/final on")).toBe(false);
    expect(detectUnknownSlashCommand("/silent on")).toBe("/silent");
    expect(detectUnknownSlashCommand("/final on")).toBe("/final");
  });
});

describe("/steps over WeChat", () => {
  it("reports standard by default", async () => {
    const { bridge } = makeBridge();
    await send(bridge, "/steps");
    await flushTicks();
    expect(texts().some((t) => t.includes("工作步骤展示: 标准"))).toBe(true);
    expect(texts().some((t) => t.includes("静默模式") || t.includes("结论模式"))).toBe(false);
  });

  it("switches all three modes and persists the enum", async () => {
    const { bridge, dir } = makeBridge();

    await send(bridge, "/steps 极简");
    await flushTicks();
    expect(bridge.workSteps()).toBe("minimal");
    expect(new ConfigStore(dir).stored().workSteps).toBe("minimal");
    expect(texts().some((t) => t.includes("极简"))).toBe(true);

    sendTextMessage.mockClear();
    await send(bridge, "/steps 简洁");
    await flushTicks();
    expect(bridge.workSteps()).toBe("concise");
    expect(new ConfigStore(dir).stored().workSteps).toBe("concise");
    expect((bridge as any).state.getUser("u1").silent).toBe(true);

    sendTextMessage.mockClear();
    await send(bridge, "/steps 标准");
    await flushTicks();
    expect(bridge.workSteps()).toBe("standard");
    expect(new ConfigStore(dir).stored().workSteps).toBe("standard");
    expect((bridge as any).state.getUser("u1").silent).toBe(false);
  });

  it("delivers the hold when leaving minimal", async () => {
    const { bridge } = makeBridge({ workSteps: "minimal", finalOnlyIdleMs: 60_000 });
    goalRound(bridge, 1, "离开极简前暂存的结论");
    await flushTicks();
    expect(texts()).toHaveLength(0);

    await send(bridge, "/steps 标准");
    await flushTicks();
    await sleep(10);
    expect(bridge.workSteps()).toBe("standard");
    expect(texts().some((t) => t.includes("离开极简前暂存的结论"))).toBe(true);
  });

  it("answers /flush with the non-minimal explanation", async () => {
    const { bridge } = makeBridge({ workSteps: "standard" });
    await send(bridge, "/flush");
    await flushTicks();
    expect(texts().some((t) => t.includes("工作步骤不是极简"))).toBe(true);
  });
});

describe("/status and help use the new single row", () => {
  it("prints one 工作步骤 row and no old mode rows", async () => {
    const { bridge } = makeBridge({ workSteps: "concise" });
    await send(bridge, "/status");
    await flushTicks();
    const status = texts().find((t) => t.includes("当前状态"))!;
    expect(status).toContain("• 工作步骤: 🔴 简洁");
    expect(status).not.toContain("• 静默模式:");
    expect(status).not.toContain("• 结论模式:");
  });

  it("no longer resolves /help silent or /help final", async () => {
    const { bridge } = makeBridge();
    await send(bridge, "/help silent");
    await flushTicks();
    expect(texts().some((t) => t.includes("没有 /silent 这条命令"))).toBe(true);

    sendTextMessage.mockClear();
    await send(bridge, "/help final");
    await flushTicks();
    expect(texts().some((t) => t.includes("没有 /final 这条命令"))).toBe(true);
  });
});
