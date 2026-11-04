/**
 * Teardown: nothing the plugin started may outlive its dispose.
 *
 * The DSH desktop host treats a plugin dispose as the end of its graceful
 * window: after the disposer resolves the host only sets `process.exitCode`
 * and waits for the event loop to drain (see `createProcessShutdown`), and
 * SIGTERMs the process 10 s later if it does not. A ref'd timer or an open
 * socket left behind by a plugin is therefore not a leak in the usual sense —
 * it aborts every in-app update with "Host did not complete graceful task
 * teardown".
 *
 * The QR scan poll was the worst offender: `login()` polls for up to 5 minutes
 * and `stop()` only cancelled the long-poll monitor, so an app quit while
 * logged out kept talking to the gateway long after teardown finished.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { login, LoginCancelledError } from "../src/weixin/auth.js";
import { apply } from "../src/index.js";
import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";

let statusPolls = 0;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-teardown-"));
}

/** iLink gateway stub: QR code once, then "wait" forever. */
function stubGateway(): void {
  statusPolls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("get_bot_qrcode")) {
        return new Response(JSON.stringify({ qrcode: "qr-1", qrcode_img_content: "https://gw.invalid/qr" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("get_qrcode_status")) {
        statusPolls += 1;
        return new Response(JSON.stringify({ status: "wait" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  stubGateway();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("QR login poll is cancellable", () => {
  it("aborts mid-poll instead of waiting out the 5-minute deadline", async () => {
    const ac = new AbortController();
    const dir = tempDir();
    const task = login({
      baseUrl: "https://gw.invalid",
      storageDir: dir,
      log: () => {},
      abortSignal: ac.signal,
    });

    await wait(50);
    expect(statusPolls).toBe(1);

    // The loop is now inside its 1.5 s inter-poll sleep; the abort must cut
    // that sleep, not be noticed only on the next iteration.
    ac.abort();
    await expect(task).rejects.toBeInstanceOf(LoginCancelledError);
    expect(statusPolls).toBe(1);

    await wait(200);
    expect(statusPolls).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a cancel as such, not as a network failure", async () => {
    const ac = new AbortController();
    const dir = tempDir();
    const task = login({ baseUrl: "https://gw.invalid", storageDir: dir, log: () => {}, abortSignal: ac.signal });
    ac.abort();
    await expect(task).rejects.toMatchObject({ code: "LOGIN_CANCELLED" });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("bridge.stop() stops the QR scan poll", () => {
  it("leaves no poll running after dispose", async () => {
    const dir = tempDir();
    const ctx = { get: () => undefined, on: () => () => {} };
    const bridge = new WeChatDSHBridge(ctx, { ...defaultConfig(), storageDir: dir, baseUrl: "https://gw.invalid" });

    await bridge.start(); // no token → QR login flow, fire-and-forget
    await wait(50);
    const before = statusPolls;
    expect(before).toBeGreaterThan(0);

    await bridge.stop();
    // A cancelled flow is not a failure: the settings page must not flash
    // "登录失败" because the app is quitting.
    expect(bridge.getStatus()).toMatchObject({ phase: "idle" });

    await wait(200);
    expect(statusPolls).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The bug that made every in-app update fail.
 *
 * This host's cordis does NOT treat a functional plugin's return value as a
 * disposer: `apply()`'s `() => bridge.stop()` was dropped on the floor, so
 * dispose completed without ever stopping the iLink long poll. The host then
 * set `process.exitCode` and waited for an event loop that could not drain
 * (a live socket, plus the request timers behind it), got SIGTERM'd after its
 * 10 s grace window, and the updater refused the "unclean" exit.
 *
 * Verified against the real desktop host: with the return value alone the
 * plugin's dispose never ran; parked on `ctx.effect` it runs in ~35 ms and the
 * process exits 216 ms after the shutdown request.
 */
describe("disposer contract: ctx.effect, not the returned function", () => {
  it("tears the bridge down through ctx.effect when the return value is ignored", async () => {
    const dir = tempDir();
    const effects: Array<() => unknown> = [];
    const ctx = {
      get: () => undefined,
      on: () => () => {},
      inject: (_deps: string[], callback: (ctx: unknown) => unknown) => callback(ctx),
      effect: (body: () => unknown) => {
        const disposer = body();
        if (typeof disposer === "function") effects.push(disposer as () => unknown);
        return () => {};
      },
    };

    const returned = apply(ctx as never, { storageDir: dir, baseUrl: "https://gw.invalid" } as never);
    await wait(50);
    const before = statusPolls;
    expect(before).toBeGreaterThan(0); // the QR poll is live
    expect(typeof returned).toBe("function"); // legacy hosts still get one

    // Exactly what the host does: run the parked effects, drop the return value.
    expect(effects.length).toBeGreaterThan(0);
    for (const dispose of effects) await dispose();

    // The long poll / QR poll must be gone, not merely "dispose returned".
    await wait(200);
    expect(statusPolls).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
