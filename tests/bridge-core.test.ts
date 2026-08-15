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
  parseRejectPermissionCommand,
  parseRejectQuestionCommand,
  parseSessionCommand,
  parseSilentCommand,
  parseStatusCommand,
  parseStopCommand,
  parseWorkspaceCommand,
  detectUnknownSlashCommand,
  formatHelp,
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
    expect(help).toContain("/silent");
    expect(help).toContain("/stop");
    expect(help).toContain("/next");
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
