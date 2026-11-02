/**
 * DSH 0.1.5-rc.1 adapter surface:
 *   - setup(agentCtx, agent) — ctx.agent is gone
 *   - session.snapshotEvents() is the public live-log read
 */

import { describe, expect, it, vi } from "vitest";
import { agentSetup } from "../src/dsh/sessions.js";
import { DshOps } from "../src/dsh/ops.js";
import { sessionEvents, type Agent, type AgentSession } from "../src/dsh/types.js";

function agentLike(session: AgentSession): Agent {
  return {
    id: "session-1",
    status: "idle",
    options: {},
    session,
    followup: () => {},
    steer: () => {},
    cancel: () => {},
    whenIdle: async () => {},
    runMaintenance: async (task) => task(new AbortController().signal),
  };
}

describe("agentSetup (DSH 0.1.5 removed ctx.agent)", () => {
  it("mounts the preset and model from the explicit agent argument", async () => {
    const mount = vi.fn(async () => ({}));
    const currentSelection = vi.fn(() => ({ provider: "deepseek", model: "deepseek-chat" }));
    const on = vi.fn();
    const ctx = {
      get: (name: string) => {
        if (name === "agentPresets") return { mount };
        if (name === "agentDefaultModel") return { currentSelection };
        return undefined;
      },
      on,
    };
    const agent = agentLike({
      header: { agentPreset: "cordis" },
      requestHeader: () => ({
        config: { provider: "openrouter", model: "inclusionai/ling", reasoningEffort: "high" },
      }),
    });

    await agentSetup(ctx, agent);

    expect(mount).toHaveBeenCalledWith(ctx, "cordis");
    expect(on).toHaveBeenCalledWith("system-prompt/assemble", expect.any(Function));
    expect(on).toHaveBeenCalledWith("agent/request", expect.any(Function));
  });

  it("does not read ctx.agent when the explicit agent is passed", async () => {
    const mount = vi.fn(async () => ({}));
    const ctx = {
      agent: agentLike({ header: { agentPreset: "should-not-use" } }),
      get: (name: string) => (name === "agentPresets" ? { mount } : undefined),
      on: vi.fn(),
    };
    const agent = agentLike({ header: { agentPreset: "cordis" } });
    await agentSetup(ctx, agent);
    expect(mount).toHaveBeenCalledWith(ctx, "cordis");
  });

  it("falls back to ctx.agent for pre-0.1.5 hosts that omit the second arg", async () => {
    const mount = vi.fn(async () => ({}));
    const ctx = {
      agent: agentLike({ header: { agentPreset: "legacy" } }),
      get: (name: string) => (name === "agentPresets" ? { mount } : undefined),
      on: vi.fn(),
    };
    await agentSetup(ctx);
    expect(mount).toHaveBeenCalledWith(ctx, "legacy");
  });
});

describe("sessionEvents prefers snapshotEvents", () => {
  it("reads snapshotEvents even when the legacy events array is empty", () => {
    const session: AgentSession = {
      events: [],
      snapshotEvents: () => [
        { type: "user/message", time: 1, data: { source: { kind: "user" } } },
      ],
    };
    expect(sessionEvents(session)).toHaveLength(1);
    expect(sessionEvents(session)[0]!.type).toBe("user/message");
  });

  it("falls back to events when snapshotEvents is absent", () => {
    const session: AgentSession = {
      events: [{ type: "assistant/message", time: 2 }],
    };
    expect(sessionEvents(session)).toEqual([{ type: "assistant/message", time: 2 }]);
  });

  it("falls back to events when snapshotEvents throws", () => {
    const session: AgentSession = {
      events: [{ type: "session/title", data: { title: "ok" } }],
      snapshotEvents: () => {
        throw new Error("detached");
      },
    };
    expect(sessionEvents(session)[0]!.type).toBe("session/title");
  });
});

describe("DshOps live log via snapshotEvents", () => {
  it("readSessionTurns reads snapshotEvents without a legacy events array", async () => {
    // `/history` and `/fork` both fold this log; the live path is the one that
    // matters for the bound session, and it must not need `session.events`.
    const events = [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      { type: "user/message", seq: 1, time: 2, data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "你好" }] } },
      { type: "assistant/message", seq: 2, time: 3, data: { message: { content: [{ type: "text", text: "收到" }] } } },
      { type: "turn/end", seq: 3, time: 4, data: { turn: 1 } },
    ];
    const agent = {
      session: { snapshotEvents: () => events },
    };
    const ops = new DshOps({
      get: (name: string) => (name === "agents" ? { get: () => agent } : undefined),
      on: () => () => {},
    });
    await expect(ops.readSessionTurns("s-1")).resolves.toEqual([
      // Two clocks, not one: the human spoke at 2, the turn closed at 4.
      { turn: 1, prompt: "你好", reply: "收到", startSeq: 0, endSeq: 3, promptTime: 2, replyTime: 4 },
    ]);
  });
});
