/**
 * Host-contract hardening guards that only show up at the plugin boundary:
 *
 *   - `send_wechat` must be UNREGISTERED when the plugin is disposed. The
 *     registration's disposer used to be discarded, so a reload left the tool
 *     bound to a dead bridge.
 *   - the settings panel's `slots.inject` disposer must survive into the
 *     plugin's effect (same failure shape: a panel that outlives its plugin).
 *
 * Both halves are checked structurally — the real Cordis runtime is not
 * present in this repo, so the tests drive `apply()` with a recording fake.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply } from "../src/index.js";

const client = fs.readFileSync(fileURLToPath(new URL("../src/client.js", import.meta.url)), "utf8");

/** Minimal context recording what the plugin registered and how it disposes. */
function makeHostContext() {
  const disposed: string[] = [];
  const effects: Array<() => unknown> = [];
  const toolsRegister = vi.fn((definition: { name?: string }) => () => {
    disposed.push(definition.name ?? "?");
  });
  const ctx = {
    get: (name: string) => (name === "tools" ? { register: toolsRegister } : undefined),
    on: () => () => {},
    inject: (_deps: string[], callback: (ctx: unknown) => unknown) => callback(ctx),
    effect: (body: () => unknown) => {
      const disposer = body();
      if (typeof disposer === "function") effects.push(disposer as () => unknown);
      return () => {};
    },
  };
  return { ctx, disposed, effects, toolsRegister };
}

/** One applied plugin plus the storage dir it must clean up. */
async function applyPlugin() {
  const host = makeHostContext();
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-dispose-"));
  const stop = apply(host.ctx as never, { storageDir, workSteps: "concise" } as never) as () => Promise<void>;
  return { host, stop, storageDir };
}

describe("A4: send_wechat registration is parked on a disposer", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("captures the tools.register disposer through ctx.effect", async () => {
    const { host, storageDir } = await applyPlugin();
    try {
      expect(host.toolsRegister).toHaveBeenCalledTimes(1);
      expect(host.toolsRegister.mock.calls[0]![0]).toMatchObject({ name: "send_wechat" });
      // The effect body returned the unregister function; the host owns it now.
      expect(host.effects.length).toBeGreaterThan(0);
      expect(host.disposed).toEqual([]);
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it("running the parked disposer unregisters the tool", async () => {
    const { host, storageDir } = await applyPlugin();
    try {
      for (const dispose of host.effects) dispose();
      expect(host.disposed).toContain("send_wechat");
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });
});

describe("A5: the settings panel registration is parked too", () => {
  it("wraps slots.inject in ctx.effect and keeps the panel definition", () => {
    expect(client).toContain("ctx.effect(register)");
    expect(client).toContain('ctx.slots.inject("settings.section"');
    expect(client).toContain('id: "wechat"');
    expect(client).toContain('label: "WeChat"');
  });

  it("falls back to the bare call when the kernel has no ctx.effect", () => {
    expect(client).toContain("else register();");
  });

  it("the client half loads and applies against a fake client context", () => {
    // Exercise the module factory exactly as the browser kernel does.
    const registered: Array<Record<string, unknown>> = [];
    let injectKey: string | undefined;
    let effectCalls = 0;
    let declaredInject: string[] = [];
    const fakeWindow = {
      __ModuleLoader__: {
        load: (spec: {
          factory: (require: (id: string) => unknown) => {
            apply: (ctx: unknown) => void;
            inject: string[];
          };
        }) => {
          const mod = spec.factory((id: string) => {
            if (id !== "react") throw new Error(`unexpected require ${id}`);
            return {
              createElement: () => null,
              useState: () => [null, () => {}],
              useCallback: (f: unknown) => f,
              useEffect: () => {},
            };
          });
          declaredInject = mod.inject;
          const ctx = {
            effect: (body: () => unknown) => {
              effectCalls += 1;
              body();
            },
            slots: {
              inject: (key: string, run: () => unknown) => {
                injectKey = key;
                run();
              },
              register: (definition: Record<string, unknown>) => {
                registered.push(definition);
              },
            },
          };
          mod.apply(ctx);
        },
      },
    };
    // eslint-disable-next-line no-new-func -- the client bundle is a script, not a module
    const run = new Function("window", "document", "setInterval", "clearInterval", client);
    run(fakeWindow, undefined, () => 0, () => {});
    expect(declaredInject).toEqual(["slots"]);
    expect(injectKey).toBe("settings.section");
    expect(effectCalls).toBe(1);
    expect(registered).toEqual([
      { name: "settings.section", id: "wechat", order: 40, label: "WeChat" },
    ]);
  });
});
