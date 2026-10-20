/**
 * Model selection sync between WeChat and the GUI.
 *
 * DSH 0.2.1 owns per-Session model selection in the Host: the GUI picker and
 * `session.selectModel` append a durable `model/selection` event, and the
 * `modelSelection` projection exposes `{ next, lastUsed }`. The bridge must
 * read that same state live — a snapshot frozen at `agentSetup` time is what
 * produced "I switched the model in the GUI but WeChat still used the old
 * one" (the snapshot kept forcing the model that was current at resume).
 *
 * These tests pin the live read: after the projection changes, the very next
 * `agent/request` waterfall uses the new route, and `system-prompt/assemble`
 * publishes the new `{{model}}` variables.
 */

import { describe, expect, it } from "vitest";
import { agentSetup } from "../src/dsh/sessions.js";
import { modelSelectionFromProjection } from "../src/dsh/types.js";

function makeAgent(sessionHeader?: { provider: string; model: string; reasoningEffort?: string }) {
  return {
    id: "session-modelsync",
    status: "idle",
    options: { provider: "magpie", model: "auto/deepseek-v4.1-flash" },
    session: {
      seq: 1,
      requestHeader: () =>
        sessionHeader ? { config: sessionHeader } : undefined,
    },
    followup: () => {},
    steer: () => {},
    cancel: () => {},
    whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) =>
      task(new AbortController().signal),
  };
}

async function makeHarness(initialProjection: unknown) {
  let projection = initialProjection;
  const listeners: Record<string, (...args: unknown[]) => unknown> = {};
  const ctx = {
    get: (name: string) => {
      if (name === "sessionProjections") {
        return {
          snapshot: () => ({
            asOfSeq: 1,
            values: { modelSelection: projection },
          }),
        };
      }
      if (name === "sessionController") {
        // Presence of the controller switches agentSetup to the live-read
        // path; the waterfall itself only needs the marker here.
        return { selectModel: async () => ({ selected: null }) };
      }
      if (name === "agentDefaultModel") {
        return {
          currentSelection: () => ({
            provider: "magpie",
            model: "auto/deepseek-v4.1-flash",
            reasoningEffort: "max",
          }),
        };
      }
      return undefined;
    },
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      listeners[event] = listener;
      return () => {};
    },
  };
  const agent = makeAgent({
    provider: "magpie",
    model: "auto/deepseek-v4.1-flash",
    reasoningEffort: "low",
  });
  await agentSetup(ctx, agent as never);
  return {
    agent,
    listeners,
    setProjection: (next: unknown) => {
      projection = next;
    },
  };
}

describe("modelSelection projection parser", () => {
  it("prefers next over lastUsed", () => {
    expect(
      modelSelectionFromProjection({
        next: { provider: "openai", model: "gpt-4" },
        lastUsed: { provider: "deepseek", model: "deepseek-chat" },
      }),
    ).toEqual({ provider: "openai", model: "gpt-4" });
  });

  it("falls back to lastUsed when no pending selection exists", () => {
    expect(
      modelSelectionFromProjection({
        next: null,
        lastUsed: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
      }),
    ).toEqual({ provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" });
  });

  it("ignores absent and malformed values", () => {
    expect(modelSelectionFromProjection(undefined)).toBeUndefined();
    expect(modelSelectionFromProjection({ next: { provider: "x" } })).toBeUndefined();
    expect(modelSelectionFromProjection({ next: "nope" })).toBeUndefined();
  });
});

describe("agentSetup follows the live host selection", () => {
  it("captures the selection at assembly and defers a mid-step switch", async () => {
    const { listeners, setProjection } = await makeHarness({
      next: {
        provider: "magpie",
        model: "auto/deepseek-v4.1-flash",
        reasoningEffort: "max",
      },
      lastUsed: null,
    });
    const request = listeners["agent/request"]!;
    const assemble = listeners["system-prompt/assemble"]!;
    const next = async () => ({
      provider: "magpie",
      model: "old-route",
      reasoningEffort: "low",
    });

    // Step 1 assembly snapshots flash/max.
    await assemble({}, {}, async () => ({}));
    await expect(request({}, next)).resolves.toEqual({
      provider: "magpie",
      model: "auto/deepseek-v4.1-flash",
      reasoningEffort: "max",
    });

    // A GUI switch lands while step 1 is still running: the request already
    // assembled must keep its model (no split prompt/route within one step).
    setProjection({
      next: { provider: "openai", model: "gpt-4" },
      lastUsed: { provider: "magpie", model: "auto/deepseek-v4.1-flash" },
    });
    await expect(request({}, next)).resolves.toEqual({
      provider: "magpie",
      model: "auto/deepseek-v4.1-flash",
      reasoningEffort: "max",
    });

    // Step 2 assembly sees the switch and the following request uses it.
    await assemble({}, {}, async () => ({}));
    await expect(request({}, next)).resolves.toEqual({
      provider: "openai",
      model: "gpt-4",
    });
  });

  it("falls back to the logged request header when no projection is available", async () => {
    const { listeners } = await makeHarness(undefined);
    const request = listeners["agent/request"]!;
    const next = async () => ({
      provider: "magpie",
      model: "old-route",
      reasoningEffort: "low",
    });

    await expect(request({}, next)).resolves.toEqual({
      provider: "magpie",
      model: "auto/deepseek-v4.1-flash",
      reasoningEffort: "low",
    });
  });

  it("publishes the live selection in prompt variables", async () => {
    const { listeners } = await makeHarness({
      next: { provider: "openai", model: "gpt-4" },
      lastUsed: null,
    });
    const assemble = listeners["system-prompt/assemble"]!;
    const next = async () => ({ variables: { provider: "old", model: "old-route" } });

    await expect(assemble({}, {}, next)).resolves.toEqual({
      variables: { provider: "openai", model: "gpt-4" },
    });
  });
});
