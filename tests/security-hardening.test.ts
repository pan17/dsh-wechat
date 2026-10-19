/**
 * Security hardening wave — S1…S4.
 *
 * Every case drives a real public entry (`handleMessage` for the WeChat-side
 * commands, `handleSendWeChat` for the tool, the bridge constructor for the
 * upgrade migration) and asserts the OUTCOME a user could observe, not that a
 * private helper was called.
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
import { ConfigStore } from "../src/config-store.js";
import { defaultConfig } from "../src/config.js";
import { StateStore } from "../src/state.js";
import { MessageType } from "../src/weixin/types.js";
import { AuditLog } from "../src/utils/audit.js";
import { maskUserId } from "../src/utils/redact.js";

const live: Array<{ stop(): Promise<void> }> = [];
const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function textMessage(text: string, from = "u1") {
  return {
    message_type: MessageType.USER,
    from_user_id: from,
    context_token: "tok",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

const asInbound = (bridge: unknown) => bridge as { handleMessage(m: unknown): Promise<void> };
const lastReply = () => String(sendTextMessage.mock.calls.at(-1)?.[1] ?? "");
const replies = () => sendTextMessage.mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const bridge of live.splice(0)) await bridge.stop().catch(() => {});
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ─── S1: /perm default must not escalate the GLOBAL default from chat ───

const PERMISSION_PRESETS: Record<string, { sandbox: string; approval: string }> = {
  "read-only": { sandbox: "read-only", approval: "ask" },
  "workspace-write": { sandbox: "workspace-write", approval: "ask" },
  "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
  // Config-declared preset that only drops approvals: the sandbox alone would
  // not catch this one.
  "approval-off": { sandbox: "workspace-write", approval: "never" },
};

function permissionService() {
  const names = Object.keys(PERMISSION_PRESETS);
  return {
    names,
    defaultPreset: "workspace-write",
    current: () => "workspace-write",
    set: vi.fn(),
    resolve: (name: string) => {
      const spec = PERMISSION_PRESETS[name];
      if (!spec) throw new Error(`unknown preset ${name}`);
      return { ...spec, name };
    },
    optionOf: (name: string) => ({ value: name, name }),
  };
}

function makePermBridge(patch: Record<string, unknown> = {}) {
  const dir = tmpDir("dsh-wx-perm-");
  const service = permissionService();
  const settingsUpdate = vi.fn(async () => {});
  const agent = { id: "wx-s1", status: "idle", options: {}, followup: () => {}, steer: () => {}, cancel: () => {}, whenIdle: async () => {} };
  const services: Record<string, unknown> = {
    permissionPresets: service,
    settings: { update: settingsUpdate, describe: () => [] },
    agents: { get: (id: string) => (id === "wx-s1" ? agent : undefined), create: async () => ({ agent }), resume: async () => ({ agent }), list: () => [agent] },
  };
  const bridge = new WeChatDSHBridge(
    { get: (name: string) => services[name], on: () => () => {} },
    { ...defaultConfig(), storageDir: dir, mergeSilenceMs: 0, ...patch },
  );
  (bridge as unknown as { token: unknown }).token = { baseUrl: "https://gw", token: "t", accountId: "b1", userId: "bot", savedAt: "" };
  (bridge as any).state.ensureUser("u1", dir);
  (bridge as any).state.update("u1", { sessionId: "wx-s1" });
  live.push(bridge);
  return { bridge, service, settingsUpdate };
}

describe("S1 — /perm default cannot raise the global default from a chat message", () => {
  it("refuses danger-full-access and points at the DSH GUI settings page", async () => {
    const { bridge, settingsUpdate } = makePermBridge();
    await asInbound(bridge).handleMessage(textMessage("/perm default danger-full-access"));
    expect(settingsUpdate).not.toHaveBeenCalled();
    const reply = lastReply();
    expect(reply).toContain("已拒绝");
    expect(reply).toContain("设置");
    expect(reply).toContain("allowRemotePermissionEscalation");
  });

  it("refuses a preset that only drops approvals (approval=never)", async () => {
    const { bridge, settingsUpdate } = makePermBridge();
    await asInbound(bridge).handleMessage(textMessage("/perm default approval-off"));
    expect(settingsUpdate).not.toHaveBeenCalled();
    expect(lastReply()).toContain("已拒绝");
  });

  it("refuses by preset INDEX too (the guard is on the resolved preset, not the text)", async () => {
    const { bridge, settingsUpdate } = makePermBridge();
    await asInbound(bridge).handleMessage(textMessage("/perm default 3"));
    expect(settingsUpdate).not.toHaveBeenCalled();
    expect(lastReply()).toContain("已拒绝");
  });

  it("still allows a NON-escalating default write", async () => {
    const { bridge, settingsUpdate } = makePermBridge();
    await asInbound(bridge).handleMessage(textMessage("/perm default read-only"));
    expect(settingsUpdate).toHaveBeenCalledWith("permission", { defaultPreset: "read-only" });
    expect(lastReply()).toContain("✅");
  });

  it("leaves the session-scoped /perm switch untouched (it is not persistent)", async () => {
    const { bridge, service, settingsUpdate } = makePermBridge();
    await asInbound(bridge).handleMessage(textMessage("/perm switch danger-full-access"));
    expect(service.set).toHaveBeenCalledTimes(1);
    expect(settingsUpdate).not.toHaveBeenCalled();
    expect(lastReply()).toContain("当前会话权限已切换");
  });

  it("the escape hatch restores the previous behaviour when explicitly enabled", async () => {
    const { bridge, settingsUpdate } = makePermBridge({ allowRemotePermissionEscalation: true });
    await asInbound(bridge).handleMessage(textMessage("/perm default danger-full-access"));
    expect(settingsUpdate).toHaveBeenCalledWith("permission", { defaultPreset: "danger-full-access" });
    expect(lastReply()).toContain("✅");
  });
});

// ─── S2: send_wechat is not an arbitrary-file-read primitive ───

function makeSendBridge(patch: Record<string, unknown> = {}, workspaces: Array<{ path: string }> = []) {
  const dir = tmpDir("dsh-wx-sendbound-");
  const services: Record<string, unknown> = {
    agents: { get: () => undefined, create: async () => undefined, resume: async () => undefined, list: () => [] },
  };
  if (workspaces.length > 0) {
    services.workspaceRegistry = {
      list: () => workspaces.map((w, i) => ({ id: `ws${i}`, title: "ws", sessionIds: [], createdAt: "", path: w.path })),
      archivedSessionIds: [],
      resolveByPath: async () => undefined,
    };
  }
  const bridge = new WeChatDSHBridge(
    { get: (name: string) => services[name], on: () => () => {} },
    { ...defaultConfig(), storageDir: dir, mergeSilenceMs: 0, ...patch },
  );
  (bridge as unknown as { token: unknown }).token = { baseUrl: "https://gw", token: "t", accountId: "b1", userId: "bot", savedAt: "" };
  live.push(bridge);
  return { bridge, dir };
}

describe("S2 — send_wechat file bound", () => {
  it("refuses a path outside the sending session's workspace", async () => {
    const { bridge, dir } = makeSendBridge();
    (bridge as any).state.ensureUser("u1", dir);
    (bridge as any).state.update("u1", { sessionId: "wx-s1" });
    const outside = path.join(tmpDir("dsh-wx-outside-"), "secret.txt");
    fs.writeFileSync(outside, "top secret");

    const result = await bridge.handleSendWeChat("wx-s1", { file_path: outside });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("refused");
    expect(result.message).toContain("allowAnyFilePath");
    expect(sendMediaMessage).not.toHaveBeenCalled();
  });

  it("allows a file inside the sending session's working directory", async () => {
    const { bridge, dir } = makeSendBridge();
    (bridge as any).state.ensureUser("u1", dir);
    (bridge as any).state.update("u1", { sessionId: "wx-s1" });
    const inside = path.join(dir, "report.txt");
    fs.writeFileSync(inside, "ok");

    const result = await bridge.handleSendWeChat("wx-s1", { file_path: inside });
    expect(result.ok).toBe(true);
    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
  });

  it("allows a file inside a REGISTERED WORKSPACE", async () => {
    const workspace = tmpDir("dsh-wx-ws-");
    const { bridge } = makeSendBridge({}, [{ path: workspace }]);
    (bridge as any).state.ensureUser("u1", tmpDir("dsh-wx-home-"));
    (bridge as any).state.update("u1", { sessionId: "wx-s1" });
    const inside = path.join(workspace, "artifact.bin");
    fs.writeFileSync(inside, "bytes");

    const result = await bridge.handleSendWeChat("wx-s1", { file_path: inside });
    expect(result.ok).toBe(true);
  });

  it("cannot escape through `..` inside an allowed root", async () => {
    const { bridge, dir } = makeSendBridge();
    (bridge as any).state.ensureUser("u1", dir);
    (bridge as any).state.update("u1", { sessionId: "wx-s1" });
    const sneaky = path.join(dir, "..", "escape.txt");
    fs.writeFileSync(path.resolve(sneaky), "nope");

    const result = await bridge.handleSendWeChat("wx-s1", { file_path: sneaky });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("refused");
  });

  it("evaluates the bound against the SENDING session, not the recipient fallback", async () => {
    // u1 (bound to wx-s1) lives in `bound`; the file sits in `bound` too. The
    // tool is called from an unrelated GUI session, and `resolveUserForAgent`
    // still falls back to u1 as the RECIPIENT — but the file bound must be the
    // caller's, so this must be refused.
    const bound = tmpDir("dsh-wx-bound-");
    const { bridge } = makeSendBridge();
    (bridge as any).state.ensureUser("u1", bound);
    (bridge as any).state.update("u1", { sessionId: "wx-s1" });
    const file = path.join(bound, "private.txt");
    fs.writeFileSync(file, "private");

    const result = await bridge.handleSendWeChat("gui-session-xyz", { file_path: file });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("refused");
  });

  it("refuses a file above maxOutgoingFileBytes", async () => {
    const { bridge, dir } = makeSendBridge({ maxOutgoingFileBytes: 8 });
    (bridge as any).state.ensureUser("u1", dir);
    (bridge as any).state.update("u1", { sessionId: "wx-s1" });
    const big = path.join(dir, "big.bin");
    fs.writeFileSync(big, "0123456789");

    const result = await bridge.handleSendWeChat("wx-s1", { file_path: big });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("too large");
    expect(sendMediaMessage).not.toHaveBeenCalled();
  });

  it("allowAnyFilePath=true restores the previous behaviour", async () => {
    const { bridge } = makeSendBridge({ allowAnyFilePath: true });
    (bridge as any).state.ensureUser("u1", tmpDir("dsh-wx-any-"));
    (bridge as any).state.update("u1", { sessionId: "wx-s1" });
    const outside = path.join(tmpDir("dsh-wx-anyfile-"), "any.txt");
    fs.writeFileSync(outside, "ok");

    const result = await bridge.handleSendWeChat("wx-s1", { file_path: outside });
    expect(result.ok).toBe(true);
  });

  it("still reports a missing file clearly", async () => {
    const { bridge, dir } = makeSendBridge();
    (bridge as any).state.ensureUser("u1", dir);
    (bridge as any).state.update("u1", { sessionId: "wx-s1" });

    const result = await bridge.handleSendWeChat("wx-s1", { file_path: path.join(dir, "nope.txt") });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("file not found");
  });
});

// ─── S3: seed the inbound allowlist on upgrade ───

function makeSeedBridge(opts: { users?: Array<{ id: string; sessionId: string }>; stored?: Record<string, unknown>; freshConfig?: boolean }) {
  const dir = tmpDir("dsh-wx-seed-");
  if (opts.users) {
    const state = new StateStore(dir);
    for (const user of opts.users) {
      state.ensureUser(user.id, dir);
      if (user.sessionId) state.update(user.id, { sessionId: user.sessionId });
    }
  }
  if (opts.stored) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(opts.stored, null, 2), "utf-8");
  }
  const store = new ConfigStore(dir);
  const bridge = new WeChatDSHBridge(
    { get: () => undefined, on: () => () => {} },
    { ...store.resolve({ ...defaultConfig(), storageDir: dir }), storageDir: dir, mergeSilenceMs: 0 },
    undefined,
    store,
  );
  (bridge as unknown as { token: unknown }).token = { baseUrl: "https://gw", token: "t", accountId: "b1", userId: "bot", savedAt: "" };
  live.push(bridge);
  return { bridge, store, dir };
}

describe("S3 — allowlist seeding on upgrade", () => {
  it("seeds allowedUsers from an already bound peer and persists it", () => {
    const { store } = makeSeedBridge({ users: [{ id: "peer-7", sessionId: "session-abc" }] });
    expect(store.stored().allowedUsers).toEqual(["peer-7"]);
    // Persisted, so the next start reads a non-empty list.
    expect(new ConfigStore(store["filePath"] ? path.dirname(store["filePath"]) : "").stored().allowedUsers).toEqual(["peer-7"]);
  });

  it("locks a stranger out after seeding (the actual security outcome)", async () => {
    const { bridge } = makeSeedBridge({ users: [{ id: "peer-7", sessionId: "session-abc" }] });
    await asInbound(bridge).handleMessage(textMessage("让我进去", "stranger-9"));
    await new Promise((r) => setTimeout(r, 10));
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect((bridge as unknown as { peerUserId: string | null }).peerUserId).toBeNull();
  });

  it("shows the peer's own id in /status and notices it once", async () => {
    const { bridge } = makeSeedBridge({ users: [{ id: "peer-7", sessionId: "session-abc" }] });
    // Everything here comes FROM the seeded peer: after seeding, a message from
    // anyone else is dropped before it can produce a reply.
    await asInbound(bridge).handleMessage(textMessage("/status", "peer-7"));
    const reply = lastReply();
    expect(reply).toContain("入站白名单");
    expect(reply).toContain("peer-7");

    // The seeding notice goes out once, on the peer's first inbound message.
    expect(replies().some((r) => r.includes("升级提示") && r.includes("peer-7"))).toBe(true);
    sendTextMessage.mockClear();
    await asInbound(bridge).handleMessage(textMessage("/status", "peer-7"));
    expect(replies().some((r) => r.includes("升级提示"))).toBe(false);
  });

  it("does NOT seed on a brand-new install (first contact still wins)", async () => {
    const { bridge, store } = makeSeedBridge({});
    expect(store.stored().allowedUsers).toBeUndefined();
    await asInbound(bridge).handleMessage(textMessage("你好", "brand-new-user"));
    expect((bridge as unknown as { peerUserId: string | null }).peerUserId).toBe("brand-new-user");
    expect((bridge as unknown as { config: { allowedUsers: string[] } }).config.allowedUsers).toEqual([]);
  });

  it("never overwrites an explicitly stored empty list", () => {
    const { store } = makeSeedBridge({ users: [{ id: "peer-7", sessionId: "session-abc" }], stored: { allowedUsers: [] } });
    expect(store.stored().allowedUsers).toEqual([]);
  });

  it("keeps an existing non-empty list untouched", () => {
    const { store } = makeSeedBridge({ users: [{ id: "peer-7", sessionId: "session-abc" }], stored: { allowedUsers: ["someone-else"] } });
    expect(store.stored().allowedUsers).toEqual(["someone-else"]);
  });
});

// ─── S4: filesystem modes, masked logs, audit sink ───

const posix = process.platform !== "win32";

describe("S4 — private modes for the plugin's own files", () => {
  it("writes state.json 0600 inside a 0700 storage dir", () => {
    const dir = tmpDir("dsh-wx-modes-");
    const store = new StateStore(dir);
    store.ensureUser("u1", dir);
    if (posix) {
      expect(fs.statSync(path.join(dir, "state.json")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    } else {
      expect(fs.existsSync(path.join(dir, "state.json"))).toBe(true);
    }
  });

  it("writes config.json 0600", () => {
    const dir = tmpDir("dsh-wx-modes-");
    const store = new ConfigStore(dir);
    store.update({ allowedUsers: ["u1"] });
    if (posix) expect(fs.statSync(path.join(dir, "config.json")).mode & 0o777).toBe(0o600);
  });

  it("writes auth/token.json 0600 inside a 0700 auth dir", async () => {
    const { saveToken } = await import("../src/weixin/auth.js");
    const dir = tmpDir("dsh-wx-modes-");
    saveToken(dir, { token: "t", baseUrl: "https://gw", accountId: "a", userId: "u", savedAt: "" });
    expect(fs.existsSync(path.join(dir, "auth", "token.json"))).toBe(true);
    if (posix) {
      expect(fs.statSync(path.join(dir, "auth", "token.json")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dir, "auth")).mode & 0o777).toBe(0o700);
    }
  });
});

describe("S4 — the inbound log line carries no raw id and no raw body", () => {
  it("masks the sender and runs the preview through maskSecrets", async () => {
    const dir = tmpDir("dsh-wx-log-");
    const bridge = new WeChatDSHBridge(
      { get: () => undefined, on: () => () => {} },
      { ...defaultConfig(), storageDir: dir, mergeSilenceMs: 0 },
    );
    (bridge as unknown as { token: unknown }).token = { baseUrl: "https://gw", token: "t", accountId: "b1", userId: "bot", savedAt: "" };
    live.push(bridge);

    const logs: string[] = [];
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.c2lnbmF0dXJlLWhlcmU";
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.map(String).join(" ")));
    try {
      await asInbound(bridge).handleMessage(textMessage(jwt, "sender-1234"));
    } finally {
      spy.mockRestore();
    }
    expect(logs.some((l) => l.includes("Message from"))).toBe(true);
    expect(logs.some((l) => l.includes("sender-1234"))).toBe(false);
    expect(logs.some((l) => l.includes("se***34"))).toBe(true);
    expect(logs.some((l) => l.includes(jwt))).toBe(false);
    expect(logs.some((l) => l.includes("***"))).toBe(true);
  });
});

describe("S4 — append-only audit sink", () => {
  function readAudit(dir: string): Array<Record<string, unknown>> {
    const file = path.join(dir, "audit.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  it("records inbound, command, decision, send_wechat file and outbound events", async () => {
    const dir = tmpDir("dsh-wx-audit-");
    const agent = { id: "wx-s1", status: "idle", options: {}, followup: () => {}, steer: () => {}, cancel: () => {}, whenIdle: async () => {} };
    const services: Record<string, unknown> = {
      agents: { get: (id: string) => (id === "wx-s1" ? agent : undefined), create: async () => ({ agent }), resume: async () => ({ agent }), list: () => [agent] },
    };
    const bridge = new WeChatDSHBridge(
      { get: (name: string) => services[name], on: () => () => {} },
      { ...defaultConfig(), storageDir: dir, mergeSilenceMs: 0 },
    );
    (bridge as unknown as { token: unknown }).token = { baseUrl: "https://gw", token: "t", accountId: "b1", userId: "bot", savedAt: "" };
    (bridge as any).state.ensureUser("u1", dir);
    (bridge as any).state.update("u1", { sessionId: "wx-s1" });
    live.push(bridge);

    // inbound + slash command
    await asInbound(bridge).handleMessage(textMessage("/status"));
    // approval card decision (seeded through the replay helper, answered from WeChat)
    (bridge as unknown as {
      handleMuxFrame(frame: unknown): void;
    }).handleMuxFrame({
      type: "server-request",
      rpcId: "rpc-1",
      method: "approval/request",
      payload: { type: "approval/requested", sessionId: "wx-s1", approvalId: "appr-1", toolName: "pwsh" },
    });
    await asInbound(bridge).handleMessage(textMessage("1"));
    // send_wechat file
    const file = path.join(dir, "out.txt");
    fs.writeFileSync(file, "payload");
    await bridge.handleSendWeChat("wx-s1", { file_path: file });

    const events = readAudit(dir);
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("inbound");
    expect(kinds).toContain("command");
    expect(kinds).toContain("decision");
    expect(kinds).toContain("send_wechat-file");
    expect(kinds).toContain("outbound");

    const inbound = events.find((e) => e.event === "inbound")!;
    expect(inbound.user).toBe(maskUserId("u1"));
    expect(typeof inbound.chars).toBe("number");
    // The body is NEVER recorded.
    expect(JSON.stringify(inbound)).not.toContain("/status");
    const decision = events.find((e) => e.event === "decision")!;
    expect(decision).toMatchObject({ kind: "approval", decision: "allowed-once", tool: "pwsh" });
    const fileEvent = events.find((e) => e.event === "send_wechat-file")!;
    expect(fileEvent.result).toBe("allowed");
    expect(fileEvent.path).toBe(file);
    const command = events.find((e) => e.event === "command")!;
    expect(command.command).toBe("status");
    // Raw WeChat ids never reach the sink.
    expect(fs.readFileSync(path.join(dir, "audit.jsonl"), "utf-8")).not.toContain("\"u1\"");
  });

  it("bounds itself by rotating at the cap and keeps the previous file", () => {
    const dir = tmpDir("dsh-wx-audit-rot-");
    const logged: string[] = [];
    const audit = new AuditLog(dir, (m) => logged.push(m), 400);
    for (let i = 0; i < 40; i++) audit.record({ event: "inbound", user: "se***34", chars: i, pad: "x".repeat(20) });
    const live = fs.statSync(path.join(dir, "audit.jsonl")).size;
    // The cap is a hard ceiling: the live file never exceeds it.
    expect(live).toBeLessThanOrEqual(400);
    expect(fs.existsSync(path.join(dir, "audit.jsonl.1"))).toBe(true);
    expect(logged.some((l) => l.includes("rotated"))).toBe(true);
    // The live file is a valid JSONL tail (the sink never emits a torn line).
    const lines = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    // And the retained history is bounded to two files' worth, not 40 records.
    const previous = fs.readFileSync(path.join(dir, "audit.jsonl.1"), "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length + previous.length).toBeLessThan(40);
  });

  it("is created 0600", () => {
    const dir = tmpDir("dsh-wx-audit-mode-");
    const audit = new AuditLog(dir, () => {});
    audit.record({ event: "inbound" });
    if (posix) expect(fs.statSync(path.join(dir, "audit.jsonl")).mode & 0o777).toBe(0o600);
  });
});
