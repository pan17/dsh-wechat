import { describe, expect, it, vi } from "vitest";
import { DshOps } from "../src/dsh/ops.js";
import type { BridgeContext } from "../src/dsh/sessions.js";

function ops(settings: unknown) {
  return new DshOps({ get: (name: string) => name === "settings" ? settings : undefined } as BridgeContext);
}

describe("busyEnter settings API compatibility", () => {
  it("reads DSH 0.2 resolved form values rather than sparse overrides or other forms", () => {
    const get = vi.fn(() => ({ busyEnter: "queue" }));
    const describe = vi.fn(() => [
      { ns: "other", value: { busyEnter: "queue" } },
      { ns: "ui-conversation", value: { busyEnter: "steer" }, base: { busyEnter: "queue" }, user: {} },
    ]);
    expect(ops({ describe, get }).busyEnter()).toBe("steer");
    expect(get).not.toHaveBeenCalled();
  });

  it("reads the current form on each call when the desktop setting changes", () => {
    let value = "steer";
    const store = ops({ describe: () => [{ ns: "ui-conversation", value: { busyEnter: value } }] });
    expect(store.busyEnter()).toBe("steer");
    value = "queue";
    expect(store.busyEnter()).toBe("queue");
  });

  it("continues reading older hosts through get(ns)", () => {
    const get = vi.fn(() => ({ busyEnter: "steer" }));
    expect(ops({ get }).busyEnter()).toBe("steer");
    expect(get).toHaveBeenCalledWith("ui-conversation");
  });

  it.each([
    undefined,
    {},
    { describe: () => [] },
    { describe: () => [{ ns: "other", value: { busyEnter: "steer" } }] },
    { describe: () => [{ ns: "ui-conversation", value: { busyEnter: "invalid" } }] },
    { describe: () => { throw new Error("unavailable"); } },
    { get: () => { throw new Error("unavailable"); } },
  ])("keeps queue as the fallback when no valid setting is available (%#)", (settings) => {
    expect(ops(settings).busyEnter()).toBe("queue");
  });

  it("uses the shared update API and observes the resulting DSH 0.2 form value", async () => {
    let value = "queue";
    const update = vi.fn(async (_ns: string, patch: { busyEnter: string }) => { value = patch.busyEnter; });
    const store = ops({ describe: () => [{ ns: "ui-conversation", value: { busyEnter: value } }], update });
    expect(await store.saveBusyEnter("steer")).toBe(true);
    expect(update).toHaveBeenCalledWith("ui-conversation", { busyEnter: "steer" });
    expect(store.busyEnter()).toBe("steer");
  });
});
