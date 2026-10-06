import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { AgentStore, type BridgeContext } from "../src/dsh/sessions.js";
import { defaultConfig } from "../src/config.js";
import { saveToken } from "../src/weixin/auth.js";
import { startMonitor } from "../src/weixin/monitor.js";
import type { UserState } from "../src/state.js";
import type { WeixinMessage } from "../src/weixin/types.js";

vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage: vi.fn(async () => {}),
  sendMediaMessage: vi.fn(async () => {}),
  splitText: (text: string) => [text],
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((r) => setImmediate(r));
const dirs: string[] = [];
const bridges: WeChatDSHBridge[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-issue9-"));
  dirs.push(dir);
  return dir;
}
function message(messageId?: number, text = "你好", seq?: number): WeixinMessage {
  return {
    message_type: 1, from_user_id: "u1", message_id: messageId, seq,
    item_list: [{ type: 1, text_item: { text } }],
  };
}
function fixture(gate?: Promise<void>) {
  const received: Array<{ sessionId: string; messageId: string }> = [];
  const live = new Map<string, unknown>();
  const create = vi.fn(async (options: { sessionId: string }) => {
    if (gate) await gate;
    const agent = {
      id: options.sessionId, status: "idle", options: {},
      followup: (m: { id: string }) => received.push({ sessionId: options.sessionId, messageId: m.id }),
      steer: vi.fn(), cancel: vi.fn(), whenIdle: async () => {},
    };
    live.set(agent.id, agent);
    return { agent };
  });
  const service = {
    create, resume: vi.fn(), get: (id: string) => live.get(id), list: () => [...live.values()],
  };
  const ctx = { get: (name: string) => name === "agents" ? service : undefined, on: () => () => {} } as BridgeContext;
  const dir = tempDir();
  const bridge = new WeChatDSHBridge(ctx, { ...defaultConfig(), storageDir: dir });
  bridges.push(bridge);
  const token = { baseUrl: "https://gw.invalid", token: "fake", accountId: "b1", userId: "u1", savedAt: "" };
  const harness = bridge as unknown as {
    token: typeof token;
    handleMessage(msg: WeixinMessage): Promise<void>;
    processMessage(msg: WeixinMessage): Promise<void>;
    startMonitor(): Promise<void>;
    monitorRunning: boolean;
  };
  harness.token = token;
  saveToken(dir, token);
  return { bridge, harness, create, received, dir, ctx };
}
function response(msgs: WeixinMessage[], cursor = "next"): Response {
  return new Response(JSON.stringify({ ret: 0, msgs, get_updates_buf: cursor }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  // Each test resolves its simulated pending polls before cleanup.
  for (const bridge of bridges.splice(0)) await bridge.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("dsh-wx-issue9-")) {
      throw new Error("unexpected test cleanup path");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("issue #9: inbound identity and session creation", () => {
  it("delivers three concurrent copies of one server message exactly once", async () => {
    const gate = deferred<void>();
    const f = fixture(gate.promise);
    const jobs = [1, 2, 3].map(() => f.harness.handleMessage(message(100)));
    await tick();
    gate.resolve();
    await Promise.all(jobs);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.received).toHaveLength(1);
    const stored = JSON.parse(fs.readFileSync(path.join(f.dir, "state.json"), "utf8"));
    expect(stored.users.u1.sessionId).toBe(f.received[0]!.sessionId);
  });

  it("also suppresses sequential replays when a session is already bound", async () => {
    const f = fixture();
    await f.harness.handleMessage(message(101));
    await f.harness.handleMessage(message(101));
    expect(f.received).toHaveLength(1);
  });

  it("keeps equal text with different identities and messages without valid identities", async () => {
    const gate = deferred<void>();
    const f = fixture(gate.promise);
    const jobs = [message(102), message(103), message(), message(0), message(-1), message(NaN)]
      .map((msg) => f.harness.handleMessage(msg));
    await tick();
    gate.resolve();
    await Promise.all(jobs);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.received).toHaveLength(6);
    expect(new Set(f.received.map((m) => m.sessionId)).size).toBe(1);
    expect(new Set(f.received.map((m) => m.messageId)).size).toBe(6);
  });

  it("falls back to seq and keeps message_id and seq namespaces separate", async () => {
    const f = fixture();
    await f.harness.handleMessage(message(undefined, "你好", 104));
    await f.harness.handleMessage(message(0, "你好", 104));
    await f.harness.handleMessage(message(104));
    expect(f.received).toHaveLength(2);
  });

  it("allows retry after a handler throws before delivery", async () => {
    const f = fixture();
    const original = f.harness.processMessage.bind(f.harness);
    vi.spyOn(f.harness, "processMessage").mockRejectedValueOnce(new Error("transient"))
      .mockImplementation(original);
    await expect(f.harness.handleMessage(message(105))).rejects.toThrow("transient");
    await f.harness.handleMessage(message(105));
    expect(f.received).toHaveLength(1);
  });

  it("expires identities and bounds memory while retaining recent replays", async () => {
    const f = fixture();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const process = vi.spyOn(f.harness, "processMessage").mockResolvedValue(undefined);
    await f.harness.handleMessage(message(106));
    now += 30 * 60_000;
    await f.harness.handleMessage(message(106));
    expect(process).toHaveBeenCalledTimes(2);
    for (let id = 200; id < 4297; id++) await f.harness.handleMessage(message(id));
    const before = process.mock.calls.length;
    await f.harness.handleMessage(message(4296));
    expect(process).toHaveBeenCalledTimes(before);
    await f.harness.handleMessage(message(200));
    expect(process).toHaveBeenCalledTimes(before + 1);
  });

  it("deduplicates commands before they can execute their side effects", async () => {
    const f = fixture();
    const process = vi.spyOn(f.harness, "processMessage").mockResolvedValue(undefined);
    await Promise.all([f.harness.handleMessage(message(107, "/s new")), f.harness.handleMessage(message(107, "/s new"))]);
    expect(process).toHaveBeenCalledTimes(1);
    expect(f.create).not.toHaveBeenCalled();
  });

  it("clears replay identities when logging out of the bot session", async () => {
    const f = fixture();
    await f.harness.handleMessage(message(110));
    await f.bridge.logout();
    await f.harness.handleMessage(message(110));
    expect(f.received).toHaveLength(2);
  });

  it("does not deliver an in-flight creation or later messages after plugin stop", async () => {
    const gate = deferred<void>();
    const f = fixture(gate.promise);
    const incoming = f.harness.handleMessage(message(111));
    await tick();
    await f.bridge.stop();
    gate.resolve();
    await incoming;
    await f.harness.handleMessage(message(112));
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.received).toHaveLength(0);
  });

  it("creates only one replacement when concurrent callers cannot resume a corrupt session", async () => {
    const f = fixture();
    const service = f.ctx.get<{ resume: ReturnType<typeof vi.fn> }>("agents")!;
    service.resume.mockRejectedValue(new Error("corrupt session"));
    const store = new AgentStore(f.ctx);
    const user: UserState = { userId: "u1", sessionId: "broken", cwd: f.dir, silent: false };
    const results = await Promise.all([1, 2, 3].map(() => store.ensure(user, { replaceOnResumeFailure: true })));
    expect(service.resume).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((result) => result.agent!.id)).size).toBe(1);
    expect(results.filter((result) => result.replacedSessionId === "broken")).toHaveLength(1);
  });

  it("releases the creation queue after a failed creation", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("create failed"));
    const store = new AgentStore(f.ctx);
    const user: UserState = { userId: "u1", sessionId: "", cwd: f.dir, silent: false };
    const [first, second] = await Promise.all([store.ensure(user), store.ensure(user)]);
    expect(first.agent).toBeUndefined();
    expect(second.agent).toBeDefined();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(user.sessionId).toBe(second.agent!.id);
  });
});

describe("issue #9: poll cancellation and replacement", () => {
  it("forwards cancellation to fetch and returns without dispatching messages", async () => {
    const abort = new AbortController();
    let wireSignal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      wireSignal = init.signal!;
      wireSignal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const onMessage = vi.fn();
    const task = startMonitor({ baseUrl: "https://gw.invalid", storageDir: tempDir(), abortSignal: abort.signal, log() {}, onMessage });
    abort.abort();
    await task;
    expect(wireSignal.aborted).toBe(true);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("drops late responses after stop, without overwriting the durable cursor", async () => {
    const f = fixture();
    const pending = deferred<Response>();
    let wireSignal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init: RequestInit) => {
      wireSignal = init.signal!;
      return pending.promise; // Deliberately ignores abort, simulating a response race.
    }));
    await f.harness.startMonitor();
    const stopping = f.bridge.stop();
    expect(wireSignal.aborted).toBe(true);
    pending.resolve(response([message(108)]));
    await stopping;
    expect(f.received).toHaveLength(0);
    expect(fs.existsSync(path.join(f.dir, "sync-buf.json"))).toBe(false);
    expect(f.harness.monitorRunning).toBe(false);
  });

  it("starts only one replacement poll after reconnect and preserves its running state", async () => {
    const f = fixture();
    const old = deferred<Response>();
    let oldSignal!: AbortSignal;
    let newSignal!: AbortSignal;
    const fetch = vi.fn()
      .mockImplementationOnce((_url: unknown, init: RequestInit) => { oldSignal = init.signal!; return old.promise; })
      .mockImplementation((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
        newSignal = init.signal!;
        newSignal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }));
    vi.stubGlobal("fetch", fetch);
    await f.harness.startMonitor();
    const reconnects = [f.bridge.reconnect(), f.bridge.reconnect()];
    expect(oldSignal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    old.resolve(response([message(109)]));
    await Promise.all(reconnects);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(f.received).toHaveLength(0);
    expect(f.harness.monitorRunning).toBe(true);
    expect(newSignal.aborted).toBe(false);
    await f.bridge.stop();
    expect(newSignal.aborted).toBe(true);
    expect(f.harness.monitorRunning).toBe(false);
  });
});
