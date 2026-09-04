/**
 * Tests for slash-command parsers, state store, and message vendor.
 */

import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  parseHelpCommand,
  parseModelCommand,
  parseNextCommand,
  parsePermCommand,
  parsePresetCommand,
  parseReasoningCommand,
  parseRejectPermissionCommand,
  parseRejectQuestionCommand,
  parseSessionCommand,
  parseSilentCommand,
  parseSurfaceCommand,
  parseStatusCommand,
  parseStopCommand,
  parseWorkspaceCommand,
  detectUnknownSlashCommand,
  formatHelp,
  isBypassSlashCommand,
} from "../src/bridge/slash.js";
import { StateStore } from "../src/state.js";
import { createUserMessage } from "../src/dsh/messages.js";

describe("slash parsers", () => {
  it("parseHelpCommand matches /help /h /?", () => {
    expect(parseHelpCommand("/help")).toBe(true);
    expect(parseHelpCommand("/h")).toBe(true);
    expect(parseHelpCommand("/?")).toBe(true);
    expect(parseHelpCommand("/help me")).toBe(false);
    expect(parseHelpCommand("help")).toBe(false);
  });

  it("parseStatusCommand matches bare /status only", () => {
    expect(parseStatusCommand("/status")).toEqual({ kind: "status" });
    expect(parseStatusCommand("/status now")).toBeNull();
  });

  it("parseSilentCommand: bare → status, on/off/status subcommands", () => {
    expect(parseSilentCommand("/silent")).toEqual({ kind: "silent", mode: "status" });
    expect(parseSilentCommand("/sl on")).toEqual({ kind: "silent", mode: "on" });
    expect(parseSilentCommand("/silent off")).toEqual({ kind: "silent", mode: "off" });
    expect(parseSilentCommand("/silent status")).toEqual({ kind: "silent", mode: "status" });
    expect(parseSilentCommand("/silent maybe")).toBeNull();
  });

  it("parseSurfaceCommand: bare → status, on/off/status subcommands", () => {
    expect(parseSurfaceCommand("/surface")).toEqual({ kind: "surface", mode: "status" });
    expect(parseSurfaceCommand("/wxprompt on")).toEqual({ kind: "surface", mode: "on" });
    expect(parseSurfaceCommand("/surface off")).toEqual({ kind: "surface", mode: "off" });
    expect(parseSurfaceCommand("/surface status")).toEqual({ kind: "surface", mode: "status" });
    expect(parseSurfaceCommand("/surface maybe")).toBeNull();
  });

  it("parseStopCommand matches bare /stop", () => {
    expect(parseStopCommand("/stop")).toEqual({ kind: "stop" });
    expect(parseStopCommand("/stop now")).toBeNull();
  });

  it("reject parsers match aliases", () => {
    expect(parseRejectQuestionCommand("/rq")).toEqual({ kind: "reject-question" });
    expect(parseRejectQuestionCommand("/reject-question")).toEqual({ kind: "reject-question" });
    expect(parseRejectPermissionCommand("/rp")).toEqual({ kind: "reject-permission" });
    expect(parseRejectPermissionCommand("/reject-permission")).toEqual({ kind: "reject-permission" });
  });

  it("detectUnknownSlashCommand", () => {
    expect(detectUnknownSlashCommand("/workspace list")).toBe("/workspace");
    expect(detectUnknownSlashCommand("normal text")).toBeNull();
  });

  it("parseWorkspaceCommand", () => {
    expect(parseWorkspaceCommand("/workspace list")).toEqual({ kind: "list" });
    expect(parseWorkspaceCommand("/ws status")).toEqual({ kind: "status" });
    expect(parseWorkspaceCommand("/workspace switch 2")).toEqual({ kind: "switch", target: "2" });
    expect(parseWorkspaceCommand("/ws switch F:\\work")).toEqual({ kind: "switch", target: "F:\\work" });
    expect(parseWorkspaceCommand("/workspace add C:\\repo")).toEqual({ kind: "add", path: "C:\\repo" });
    expect(parseWorkspaceCommand("/workspace switch")).toBeNull();
    expect(parseWorkspaceCommand("/workspace")).toBeNull();
  });

  it("parseSessionCommand", () => {
    expect(parseSessionCommand("/session list")).toEqual({ kind: "list" });
    expect(parseSessionCommand("/s list current")).toEqual({ kind: "list", scope: "current" });
    expect(parseSessionCommand("/session list current")).toEqual({ kind: "list", scope: "current" });
    expect(parseSessionCommand("/s list foo")).toBeNull();
    expect(parseSessionCommand("/s new")).toEqual({ kind: "new" });
    expect(parseSessionCommand("/session status")).toEqual({ kind: "status" });
    expect(parseSessionCommand("/session switch 3")).toEqual({ kind: "switch", index: 3 });
    expect(parseSessionCommand("/s switch abc")).toBeNull();
    expect(parseSessionCommand("/session")).toBeNull();
  });

  it("parsePresetCommand", () => {
    expect(parsePresetCommand("/preset list")).toEqual({ kind: "list" });
    expect(parsePresetCommand("/p status")).toEqual({ kind: "status" });
    expect(parsePresetCommand("/preset switch build")).toEqual({ kind: "switch", target: "build" });
    expect(parsePresetCommand("/p switch 2")).toEqual({ kind: "switch", target: "2" });
    // Legacy aliases still parse.
    expect(parsePresetCommand("/agent list")).toEqual({ kind: "list" });
    expect(parsePresetCommand("/a switch build")).toEqual({ kind: "switch", target: "build" });
    expect(parsePresetCommand("/preset")).toBeNull();
  });

  it("parseModelCommand", () => {
    expect(parseModelCommand("/model list")).toEqual({ kind: "list" });
    expect(parseModelCommand("/model list deepseek")).toEqual({ kind: "list", provider: "deepseek" });
    expect(parseModelCommand("/model switch deepseek/deepseek-chat")).toEqual({ kind: "switch", target: "deepseek/deepseek-chat" });
    expect(parseModelCommand("/model status")).toEqual({ kind: "status" });
    expect(parseModelCommand("/model switch deepseek")).toBeNull();
    expect(parseModelCommand("/model")).toBeNull();
  });

  it("parsePermCommand", () => {
    expect(parsePermCommand("/perm status")).toEqual({ kind: "status" });
    expect(parsePermCommand("/perm list")).toEqual({ kind: "list" });
    expect(parsePermCommand("/perm switch workspace-write")).toEqual({ kind: "switch", target: "workspace-write" });
    expect(parsePermCommand("/perm switch 2")).toEqual({ kind: "switch", target: "2" });
    expect(parsePermCommand("/perm default")).toEqual({ kind: "default" });
    expect(parsePermCommand("/perm default danger-full-access")).toEqual({ kind: "default", target: "danger-full-access" });
    expect(parsePermCommand("/permission list")).toEqual({ kind: "list" });
    expect(parsePermCommand("/perm switch")).toBeNull();
    expect(parsePermCommand("/perm")).toBeNull();
    expect(parsePermCommand("/perm unknown-sub 1")).toBeNull();
  });

  it("parseReasoningCommand", () => {
    expect(parseReasoningCommand("/reasoning")).toEqual({ kind: "status" });
    expect(parseReasoningCommand("/reasoning list")).toEqual({ kind: "list" });
    expect(parseReasoningCommand("/reasoning default")).toEqual({ kind: "clear" });
    expect(parseReasoningCommand("/reasoning switch high")).toEqual({ kind: "switch", target: "high" });
    expect(parseReasoningCommand("/reasoning switch 高")).toEqual({ kind: "switch", target: "高" });
    expect(parseReasoningCommand("/reasoning  switch   thinking")).toEqual({ kind: "switch", target: "thinking" });
    expect(parseReasoningCommand(" /reasoning  ")).toEqual({ kind: "status" });
    // Bare level names (without `switch`) are no longer accepted: the
    // explicit `switch` keyword keeps the grammar consistent with the
    // other management commands (`/workspace`, `/session`, `/preset`,
    // `/model`, `/perm`).
    expect(parseReasoningCommand("/reasoning high")).toBeNull();
    expect(parseReasoningCommand("/reasoning switch")).toBeNull();
    expect(parseReasoningCommand("/reason")).toBeNull();
    expect(parseReasoningCommand("reasoning list")).toBeNull();
  });

  it("parseNextCommand", () => {
    expect(parseNextCommand("/next")).toBe(true);
    expect(parseNextCommand("  /next  ")).toBe(true);
    expect(parseNextCommand("/next more")).toBe(false);
    expect(parseNextCommand("/n")).toBe(false);
    expect(parseNextCommand("next")).toBe(false);
  });

  it("formatHelp lists the management commands", () => {
    const help = formatHelp();
    expect(help).toContain("/workspace");
    expect(help).toContain("/session");
    expect(help).toContain("/preset");
    expect(help).toContain("/model");
    expect(help).toContain("/perm");
    expect(help).toContain("/reasoning");
    expect(help).toContain("/silent");
    expect(help).toContain("/surface");
    expect(help).toContain("/stop");
    expect(help).toContain("/next");
    // /compact used to be in this list — it is now a native command
    // (dsh-command-compact) and shows up only when the host actually
    // registered it. Bare `formatHelp()` without a native snapshot
    // must NOT advertise it.
    expect(help).not.toContain("/compact");
  });
});

describe("isBypassSlashCommand", () => {
  it("flags every non-card management command", () => {
    // /help is included: its only effect is "print the help text", which
    // handleMessage already handles. The two duplicate `parseHelpCommand`
    // priority branches in the card handlers become dead code once /help
    // bypasses.
    expect(isBypassSlashCommand("/help")).toBe(true);
    expect(isBypassSlashCommand("/h")).toBe(true);
    expect(isBypassSlashCommand("/?")).toBe(true);
    expect(isBypassSlashCommand("/next")).toBe(true);
    expect(isBypassSlashCommand("/silent on")).toBe(true);
    expect(isBypassSlashCommand("/silent")).toBe(true);
    expect(isBypassSlashCommand("/sl off")).toBe(true);
    expect(isBypassSlashCommand("/surface")).toBe(true);
    expect(isBypassSlashCommand("/surface off")).toBe(true);
    expect(isBypassSlashCommand("/wxprompt on")).toBe(true);
    expect(isBypassSlashCommand("/status")).toBe(true);
    expect(isBypassSlashCommand("/workspace list")).toBe(true);
    expect(isBypassSlashCommand("/ws switch 1")).toBe(true);
    expect(isBypassSlashCommand("/session new")).toBe(true);
    expect(isBypassSlashCommand("/s list current")).toBe(true);
    expect(isBypassSlashCommand("/preset list")).toBe(true);
    expect(isBypassSlashCommand("/p switch build")).toBe(true);
    expect(isBypassSlashCommand("/model list")).toBe(true);
    expect(isBypassSlashCommand("/perm status")).toBe(true);
    expect(isBypassSlashCommand("/permission list")).toBe(true);
    expect(isBypassSlashCommand("/reasoning switch high")).toBe(true);
  });

  it("returns false for card-specific commands and plain text", () => {
    // /rp, /rq: card-management commands (reject all pending cards).
    expect(isBypassSlashCommand("/rp")).toBe(false);
    expect(isBypassSlashCommand("/reject-permission")).toBe(false);
    expect(isBypassSlashCommand("/rq")).toBe(false);
    expect(isBypassSlashCommand("/reject-question")).toBe(false);
    // /stop is intentionally NOT in the bypass set: it lives in the
    // question-card priority branch (stop-agent + reject-question) and
    // changing that behaviour is out of scope for the bypass fix.
    expect(isBypassSlashCommand("/stop")).toBe(false);
    // Plain text and unrecognized commands stay as card answers.
    expect(isBypassSlashCommand("")).toBe(false);
    expect(isBypassSlashCommand("hello")).toBe(false);
    expect(isBypassSlashCommand("1")).toBe(false);
    expect(isBypassSlashCommand("/unknown")).toBe(false);
  });
});

describe("StateStore", () => {
  it("persists and reloads user state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-state-"));
    try {
      const store = new StateStore(dir);
      const user = store.ensureUser("u1", "C:\\work");
      expect(user.sessionId).toBe("");

      store.update("u1", { sessionId: "wx-123", silent: true, cwdExplicit: true });

      const reloaded = new StateStore(dir);
      const again = reloaded.getUser("u1");
      expect(again?.sessionId).toBe("wx-123");
      expect(again?.silent).toBe(true);
      expect(again?.cwdExplicit).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists and reloads the single-peer outbound snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-state-"));
    try {
      const store = new StateStore(dir);
      store.ensureUser("u1", "C:\\work");
      store.setOutbound({
        version: 1,
        peerUserId: "u1",
        messageCount: 6,
        queue: [
          { kind: "text", text: "pending" },
          { kind: "file", filePath: "C:\\tmp\\a.png", fileName: "a.png" },
        ],
      });

      const reloaded = new StateStore(dir).outbound();
      expect(reloaded?.messageCount).toBe(6);
      expect(reloaded?.queue).toEqual([
        { kind: "text", text: "pending" },
        { kind: "file", filePath: "C:\\tmp\\a.png", fileName: "a.png" },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes malformed outbound state and caps the one FIFO", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-state-"));
    try {
      const queue = Array.from({ length: 105 }, (_, i) => ({ kind: "text", text: `m${i}` }));
      queue.splice(10, 0, { kind: "bogus", text: "bad" });
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
        users: {},
        outbound: { version: 1, peerUserId: "u1", messageCount: 99, queue },
      }), "utf-8");
      const outbound = new StateStore(dir).outbound();
      expect(outbound?.messageCount).toBe(10);
      expect(outbound?.queue).toHaveLength(100);
      expect(outbound?.queue[0]).toEqual({ kind: "text", text: "m5" });
      expect(outbound?.queue.at(-1)).toEqual({ kind: "text", text: "m104" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clearUsers drops every persisted WeChat user", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-state-"));
    try {
      const store = new StateStore(dir);
      store.ensureUser("u1", "C:\\work");
      store.update("u1", { sessionId: "wx-123" });
      store.clearUsers();
      expect(store.all()).toEqual([]);
      expect(new StateStore(dir).all()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacy state without outbound starts with an empty outbound snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-state-"));
    try {
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ users: {} }), "utf-8");
      expect(new StateStore(dir).outbound()).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corrupt state file falls back to fresh state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-state-"));
    try {
      fs.writeFileSync(path.join(dir, "state.json"), "{ not json", "utf-8");
      const store = new StateStore(dir);
      expect(store.all()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createUserMessage (vendored)", () => {
  it("produces an immutable user message with kind 'user' source (GUI-equivalent)", () => {
    const message = createUserMessage({
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user" },
    });
    expect(message.role).toBe("user");
    expect(message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(message.source).toEqual({ kind: "user" });
    expect(typeof message.id).toBe("string");
    expect(message.id.length).toBeGreaterThan(0);
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.content)).toBe(true);
  });
});
