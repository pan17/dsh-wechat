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
 * These tests pin the live read on a Host that owns the selection: the
 * `system-prompt/assemble` waterfall publishes the current `{{model}}`
 * variables, while `agent/request` is left alone — DSH 0.2.2 captures the
 * step's provider/model/reasoning effort BEFORE that waterfall and throws
 * when a listener returns anything else, failing the whole turn. A switch
 * therefore surfaces at the next assembly, never by rewriting a request in
 * flight.
 */

import { describe, expect, it } from "vitest";
import { agentSetup } from "../src/dsh/sessions.js";
import { modelSelectionFromProjection } from "../src/dsh/types.js";

function makeAgent(
  sessionHeader?: { provider: string; model: string; reasoningEffort?: string },
  model?: { current(): unknown; select(selection: unknown): void },
) {
  return {
    id: "session-modelsync",
    status: "idle",
    options: { provider: "magpie", model: "auto/deepseek-v4.1-flash" },
    ...(model ? { model } : {}),
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

describe("agentSetup seeds a route the Host will accept", () => {
  const controllerCtx = {
    get: (name: string) =>
      name === "sessionController"
        ? { selectModel: async () => ({ selected: null }) }
        : name === "agentDefaultModel"
          ? {
              currentSelection: () => ({
                provider: "magpie",
                model: "auto/deepseek-v4.1-flash",
                reasoningEffort: "max",
              }),
            }
          : undefined,
    on: () => () => {},
  };

  it("records the deployment default when the session has no route at all", async () => {
    // Exactly the `/s new` failure on 0.2.2: no recorded selection, no
    // AgentOptions route, so `preStep` threw before any waterfall ran.
    const picked: unknown[] = [];
    const agent = makeAgent(undefined, {
      current: () => undefined,
      select: (selection) => picked.push(selection),
    });
    await agentSetup(controllerCtx, agent as never);
    expect(picked).toEqual([
      { provider: "magpie", model: "auto/deepseek-v4.1-flash", reasoningEffort: "max" },
    ]);
  });

  it("keeps an existing route untouched", async () => {
    const picked: unknown[] = [];
    const agent = makeAgent(undefined, {
      current: () => ({ provider: "openai", model: "gpt-4" }),
      select: (selection) => picked.push(selection),
    });
    await agentSetup(controllerCtx, agent as never);
    expect(picked).toEqual([]);
  });

  it("prefers a resumed session's last request header over the default", async () => {
    const picked: unknown[] = [];
    const agent = makeAgent(
      { provider: "openai", model: "gpt-4", reasoningEffort: "high" },
      { current: () => undefined, select: (selection) => picked.push(selection) },
    );
    await agentSetup(controllerCtx, agent as never);
    expect(picked).toEqual([
      { provider: "openai", model: "gpt-4", reasoningEffort: "high" },
    ]);
  });

  it("stays inert on a host whose Agent exposes no model accessor", async () => {
    const agent = makeAgent(undefined);
    await expect(agentSetup(controllerCtx, agent as never)).resolves.toBeUndefined();
  });
});

describe("agentSetup follows the live host selection", () => {
  it("never rewrites the request on a host that owns the selection", async () => {
    const { listeners, setProjection } = await makeHarness({
      next: {
        provider: "magpie",
        model: "auto/deepseek-v4.1-flash",
        reasoningEffort: "max",
      },
      lastUsed: null,
    });
    // The Host fixes the step route before `agent/request`, so a listener
    // there would only be able to disagree with it (and get the turn killed).
    expect(listeners["agent/request"]).toBeUndefined();

    const assemble = listeners["system-prompt/assemble"]!;
    const next = async () => ({ variables: { provider: "old", model: "old-route" } });

    // Step 1 assembly publishes the projection.
    await expect(assemble({}, {}, next)).resolves.toEqual({
      variables: { provider: "magpie", model: "auto/deepseek-v4.1-flash" },
    });

    // A GUI switch lands while step 1 is still running: nothing retracts the
    // already-assembled prompt, and the next assembly carries the new route.
    setProjection({
      next: { provider: "openai", model: "gpt-4" },
      lastUsed: { provider: "magpie", model: "auto/deepseek-v4.1-flash" },
    });
    await expect(assemble({}, {}, next)).resolves.toEqual({
      variables: { provider: "openai", model: "gpt-4" },
    });
  });

  it("falls back to the logged request header when no projection is available", async () => {
    const { listeners } = await makeHarness(undefined);
    expect(listeners["agent/request"]).toBeUndefined();

    const assemble = listeners["system-prompt/assemble"]!;
    const next = async () => ({ variables: { provider: "old", model: "old-route" } });
    await expect(assemble({}, {}, next)).resolves.toEqual({
      variables: { provider: "magpie", model: "auto/deepseek-v4.1-flash" },
    });
  });

  it("keeps the legacy request rewrite on a host without a session controller", async () => {
    const listeners: Record<string, (...args: unknown[]) => unknown> = {};
    const ctx = {
      get: (name: string) =>
        name === "agentDefaultModel"
          ? {
              currentSelection: () => ({
                provider: "magpie",
                model: "auto/deepseek-v4.1-flash",
              }),
            }
          : undefined,
      on: (event: string, listener: (...args: unknown[]) => unknown) => {
        listeners[event] = listener;
        return () => {};
      },
    };
    await agentSetup(
      ctx,
      makeAgent({
        provider: "magpie",
        model: "auto/deepseek-v4.1-flash",
        reasoningEffort: "low",
      }) as never,
    );

    // Pre-0.2.1 hosts have no per-session selection: the frozen header still
    // drives the request, exactly as before this change.
    const request = listeners["agent/request"]!;
    expect(typeof request).toBe("function");
    await expect(
      request({}, async () => ({ provider: "magpie", model: "old-route" })),
    ).resolves.toEqual({
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
