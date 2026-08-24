/**
 * `/model switch` ↔ `/reasoning switch` interaction — covers the bug where
 * `/model switch` discarded the user's chosen `reasoningEffort`, leaving
 * `/status` (and `/reasoning status`) to silently drop the reasoning line.
 *
 * The two fixes under test:
 *
 *   1. `/model switch` preserves the existing `reasoningEffort` from the
 *      override first, then the persisted default — but only when the new
 *      model actually supports the same effort id. Otherwise the LLM call
 *      would see an unsupported value.
 *
 *   2. `resolveEffectiveModel` defensively falls back to the persisted
 *      default's `reasoningEffort` when the override carries a model
 *      selection without an effort AND the default's model matches. This
 *      rescues users whose `/model switch` (under the old code) had
 *      already cleared the override.
 *
 * Plus the `applyModelOverride` waterfall (live request path): when the
 * override lacks `reasoningEffort`, the caller's effort (from the
 * frozen config) is preserved. That branch was already correct; we just
 * pin the behavior so a future refactor does not regress it.
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

// ─── Mocks ──────────────────────────────────────────────────────────────────

interface EffortLevel {
  id: string;
  name: string;
  description?: string;
}

interface EffortMap {
  [modelId: string]: { efforts: EffortLevel[]; defaultEffort: string };
}

function makeBridge(opts: {
  /** provider/model → supported efforts + default. */
  reasoning: EffortMap;
  /** What the persisted DSH default model selection currently holds. */
  defaultModelSelection?: { provider: string; model: string; reasoningEffort?: string };
  /** Saved selections go here, in order. */
  savedSelections?: Array<{ provider: string; model: string; reasoningEffort?: string }>;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-mreason-"));

  const savedSelections = opts.savedSelections ?? [];
  const agentsService = {
    create: async () => mockAgent,
    resume: async () => mockAgent,
    get: (id: string) => (id === "wx-s1" ? mockAgent : undefined),
    list: () => [mockAgent],
  };
  const llmService = {
    listProviders: () => [
      { id: "deepseek", name: "DeepSeek" },
      { id: "openai", name: "OpenAI" },
    ],
    listModels: async (provider: string) => {
      if (provider === "deepseek") {
        return [
          { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
          { provider: "deepseek", id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
        ];
      }
      if (provider === "openai") {
        return [
          { provider: "openai", id: "gpt-4", name: "GPT-4" },
          { provider: "openai", id: "no-reasoning", name: "No Reasoning" },
        ];
      }
      return [];
    },
    resolveModelInfo: async (provider: string, model: string) => {
      const key = `${provider}/${model}`;
      const r = opts.reasoning[key];
      if (!r) return {};
      return { reasoning: { efforts: r.efforts, defaultEffort: r.defaultEffort } };
    },
  };
  const agentDefaultModelService = {
    currentSelection: () =>
      opts.defaultModelSelection ?? { provider: "deepseek", model: "deepseek-chat" },
    saveSelection: async (next: { provider: string; model: string; reasoningEffort?: string }) => {
      savedSelections.push(next);
      return true;
    },
  };

  const services: Record<string, unknown> = {
    agents: agentsService,
    llm: llmService,
    agentDefaultModel: agentDefaultModelService,
  };

  const ctx = {
    get: (name: string) => services[name],
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  cfg.cwd = dir;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "u",
    savedAt: "",
  };
  (bridge as unknown as { contextTokens: Map<string, string> }).contextTokens.set("u1", "ctx-token");
  // Bind the user to the mock agent so `agents.get(user)` resolves; the
  // model/reasoning handlers read the agent via the user→session→agent
  // chain and skip the override entirely when no agent is bound.
  const stateStore = (bridge as unknown as { state: { ensureUser: (id: string, cwd: string) => { sessionId: string }; update: (id: string, patch: { sessionId: string }) => void } }).state;
  const user = stateStore.ensureUser("u1", dir);
  stateStore.update("u1", { sessionId: "wx-s1" });
  user.sessionId = "wx-s1";
  return { bridge, dir, savedSelections };
}

const mockAgent = {
  id: "wx-s1",
  status: "idle",
  options: { provider: "deepseek", model: "deepseek-chat" },
  followup: () => {},
  steer: () => {},
  cancel: () => {},
  whenIdle: async () => {},
};

const EFFORTS_DS_CHAT: EffortMap = {
  "deepseek/deepseek-chat": {
    efforts: [
      { id: "low", name: "低" },
      { id: "high", name: "高" },
    ],
    defaultEffort: "low",
  },
  "deepseek/deepseek-reasoner": {
    efforts: [{ id: "thinking", name: "深度思考" }],
    defaultEffort: "thinking",
  },
  "openai/gpt-4": {
    efforts: [
      { id: "low", name: "Low" },
      { id: "high", name: "High" },
    ],
    defaultEffort: "low",
  },
  // openai/no-reasoning has no reasoning capability — the LLM service
  // resolves to {} which the bridge treats as "not supported".
};

function lastText(): string {
  expect(sendTextMessage).toHaveBeenCalled();
  const call = sendTextMessage.mock.calls[sendTextMessage.mock.calls.length - 1]! as [string, string];
  return call[1];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/model switch preserves reasoningEffort", () => {
  it("no existing effort → new override and saved default have no effort", async () => {
    const { bridge, savedSelections } = makeBridge({ reasoning: EFFORTS_DS_CHAT });
    await (bridge as unknown as {
      handleModelCommand(u: string, c: unknown): Promise<void>;
    }).handleModelCommand("u1", { kind: "switch", target: "openai/gpt-4" });
    const override = (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.get("wx-s1");
    expect(override).toEqual({ provider: "openai", model: "gpt-4" });
    expect(savedSelections).toEqual([{ provider: "openai", model: "gpt-4" }]);
    expect(lastText()).not.toContain("推理等级");
  });

  it("existing override effort supported by new model → effort preserved on both", async () => {
    const { bridge, savedSelections } = makeBridge({ reasoning: EFFORTS_DS_CHAT });
    // Seed the override as if /reasoning switch high had run on deepseek-chat.
    (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.set("wx-s1", {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "high",
    });
    await (bridge as unknown as {
      handleModelCommand(u: string, c: unknown): Promise<void>;
    }).handleModelCommand("u1", { kind: "switch", target: "openai/gpt-4" });
    const override = (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.get("wx-s1");
    expect(override).toEqual({ provider: "openai", model: "gpt-4", reasoningEffort: "high" });
    expect(savedSelections).toEqual([
      { provider: "openai", model: "gpt-4", reasoningEffort: "high" },
    ]);
    expect(lastText()).toContain("推理等级 High 保留");
  });

  it("persisted default effort wins when override has none", async () => {
    const { bridge, savedSelections } = makeBridge({
      reasoning: EFFORTS_DS_CHAT,
      defaultModelSelection: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
    });
    // Override is empty (simulating fresh session after restart).
    await (bridge as unknown as {
      handleModelCommand(u: string, c: unknown): Promise<void>;
    }).handleModelCommand("u1", { kind: "switch", target: "openai/gpt-4" });
    const override = (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.get("wx-s1");
    expect(override).toEqual({ provider: "openai", model: "gpt-4", reasoningEffort: "high" });
    expect(savedSelections).toEqual([
      { provider: "openai", model: "gpt-4", reasoningEffort: "high" },
    ]);
  });

  it("override effort beats default effort when both exist", async () => {
    const { bridge, savedSelections } = makeBridge({
      reasoning: EFFORTS_DS_CHAT,
      defaultModelSelection: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" },
    });
    (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.set("wx-s1", {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "high",
    });
    await (bridge as unknown as {
      handleModelCommand(u: string, c: unknown): Promise<void>;
    }).handleModelCommand("u1", { kind: "switch", target: "openai/gpt-4" });
    expect(savedSelections).toEqual([
      { provider: "openai", model: "gpt-4", reasoningEffort: "high" },
    ]);
  });

  it("effort unsupported by new model → effort dropped, override stays clean", async () => {
    const { bridge, savedSelections } = makeBridge({ reasoning: EFFORTS_DS_CHAT });
    // "thinking" is only supported by deepseek-reasoner.
    (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.set("wx-s1", {
      provider: "deepseek",
      model: "deepseek-reasoner",
      reasoningEffort: "thinking",
    });
    await (bridge as unknown as {
      handleModelCommand(u: string, c: unknown): Promise<void>;
    }).handleModelCommand("u1", { kind: "switch", target: "openai/gpt-4" });
    const override = (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.get("wx-s1");
    expect(override).toEqual({ provider: "openai", model: "gpt-4" });
    expect(savedSelections).toEqual([{ provider: "openai", model: "gpt-4" }]);
    expect(lastText()).not.toContain("保留");
  });

  it("new model with no reasoning capability at all → effort dropped", async () => {
    const { bridge, savedSelections } = makeBridge({ reasoning: EFFORTS_DS_CHAT });
    (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.set("wx-s1", {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "high",
    });
    await (bridge as unknown as {
      handleModelCommand(u: string, c: unknown): Promise<void>;
    }).handleModelCommand("u1", { kind: "switch", target: "openai/no-reasoning" });
    expect(savedSelections).toEqual([{ provider: "openai", model: "no-reasoning" }]);
    expect(lastText()).not.toContain("保留");
  });
});

describe("resolveEffectiveModel defensive fallback", () => {
  // We poke the override directly to simulate the broken pre-fix state
  // (override written without reasoningEffort) and verify the user-visible
  // resolution still recovers the effort when the persisted default
  // matches.

  it("override lacks effort, default has matching effort → falls back", async () => {
    const { bridge } = makeBridge({
      reasoning: EFFORTS_DS_CHAT,
      defaultModelSelection: { provider: "openai", model: "gpt-4", reasoningEffort: "high" },
    });
    (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.set("wx-s1", {
      provider: "openai",
      model: "gpt-4",
    });
    const resolved = (bridge as unknown as {
      resolveEffectiveModel(u: unknown, a: unknown): { provider?: string; model?: string; reasoningEffort?: string } | undefined;
    }).resolveEffectiveModel(
      (bridge as unknown as { state: { ensureUser: (id: string, cwd: string) => unknown } }).state.ensureUser("u1", "C:\\work"),
      mockAgent,
    );
    expect(resolved).toEqual({ provider: "openai", model: "gpt-4", reasoningEffort: "high" });
  });

  it("override lacks effort, default has different model → does NOT borrow effort", async () => {
    const { bridge } = makeBridge({
      reasoning: EFFORTS_DS_CHAT,
      defaultModelSelection: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
    });
    (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.set("wx-s1", {
      provider: "openai",
      model: "gpt-4",
    });
    const resolved = (bridge as unknown as {
      resolveEffectiveModel(u: unknown, a: unknown): { provider?: string; model?: string; reasoningEffort?: string } | undefined;
    }).resolveEffectiveModel(
      (bridge as unknown as { state: { ensureUser: (id: string, cwd: string) => unknown } }).state.ensureUser("u1", "C:\\work"),
      mockAgent,
    );
    expect(resolved).toEqual({ provider: "openai", model: "gpt-4" });
  });

  it("override already carries effort → returned as-is (no double-write)", async () => {
    const { bridge } = makeBridge({
      reasoning: EFFORTS_DS_CHAT,
      defaultModelSelection: { provider: "openai", model: "gpt-4", reasoningEffort: "high" },
    });
    (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.set("wx-s1", {
      provider: "openai",
      model: "gpt-4",
      reasoningEffort: "low",
    });
    const resolved = (bridge as unknown as {
      resolveEffectiveModel(u: unknown, a: unknown): { provider?: string; model?: string; reasoningEffort?: string } | undefined;
    }).resolveEffectiveModel(
      (bridge as unknown as { state: { ensureUser: (id: string, cwd: string) => unknown } }).state.ensureUser("u1", "C:\\work"),
      mockAgent,
    );
    expect(resolved).toEqual({ provider: "openai", model: "gpt-4", reasoningEffort: "low" });
  });
});

describe("applyModelOverride preserves caller's effort", () => {
  // The live request waterfall must NOT lose the caller's effort when the
  // override only carries provider+model (the pre-fix bug surface from the
  // perspective of the next LLM call). This pins the existing contract so a
  // future refactor does not regress it.

  it("override without effort leaves config.effort intact", async () => {
    const { bridge } = makeBridge({ reasoning: EFFORTS_DS_CHAT });
    (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.set("wx-s1", {
      provider: "openai",
      model: "gpt-4",
    });
    const out = (bridge as unknown as {
      applyModelOverride(
        c: { provider: string; model: string; reasoningEffort?: string },
        a: string,
      ): { provider: string; model: string; reasoningEffort?: string };
    }).applyModelOverride({ provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" }, "wx-s1");
    expect(out).toEqual({ provider: "openai", model: "gpt-4", reasoningEffort: "high" });
  });

  it("override with effort overrides config.effort (no merge)", async () => {
    const { bridge } = makeBridge({ reasoning: EFFORTS_DS_CHAT });
    (bridge as unknown as { modelOverrides: Map<string, unknown> }).modelOverrides.set("wx-s1", {
      provider: "openai",
      model: "gpt-4",
      reasoningEffort: "low",
    });
    const out = (bridge as unknown as {
      applyModelOverride(
        c: { provider: string; model: string; reasoningEffort?: string },
        a: string,
      ): { provider: string; model: string; reasoningEffort?: string };
    }).applyModelOverride({ provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" }, "wx-s1");
    expect(out).toEqual({ provider: "openai", model: "gpt-4", reasoningEffort: "low" });
  });
});