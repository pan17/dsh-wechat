/**
 * Tests for ConfigStore (editable config persistence + merge precedence).
 */

import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { ConfigStore } from "../src/config-store.js";
import { DEFAULT_SURFACE_PROMPT, defaultConfig, LEGACY_SURFACE_PROMPTS } from "../src/config.js";

describe("ConfigStore", () => {
  it("resolves defaults when nothing is stored", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      const base = defaultConfig();
      base.baseUrl = "https://custom.example.com";
      const resolved = store.resolve(base);
      expect(resolved.baseUrl).toBe("https://custom.example.com");
      expect(resolved.textChunkLimit).toBe(4000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stored values override composition config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({ baseUrl: "https://stored.example.com", cwd: "F:\\work" });

      const base = defaultConfig();
      base.baseUrl = "https://composition.example.com";
      const resolved = store.resolve(base);
      expect(resolved.baseUrl).toBe("https://stored.example.com");
      expect(resolved.cwd).toBe("F:\\work");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists across instances and ignores unknown keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({ cwd: "F:\\work", unknownKey: 42 } as never);

      const reloaded = new ConfigStore(dir);
      expect(reloaded.stored().cwd).toBe("F:\\work");
      expect("unknownKey" in reloaded.stored()).toBe(false);

      const resolved = reloaded.resolve(defaultConfig());
      expect(resolved.cwd).toBe("F:\\work");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists notifyTaskEvents as a global boolean", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({ notifyTaskEvents: true });
      expect(new ConfigStore(dir).resolve(defaultConfig()).notifyTaskEvents).toBe(true);
      store.update({ notifyTaskEvents: false });
      expect(new ConfigStore(dir).stored().notifyTaskEvents).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists silent as a global boolean", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({ silent: true });

      const reloaded = new ConfigStore(dir);
      expect(reloaded.stored().silent).toBe(true);
      expect(reloaded.resolve(defaultConfig()).silent).toBe(true);

      store.update({ silent: false });
      expect(new ConfigStore(dir).stored().silent).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-boolean silent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({ silent: "yes" as never });
      expect(store.stored().silent).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists surfacePromptEnabled and surfacePrompt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({
        surfacePromptEnabled: false,
        surfacePrompt: "custom wechat prompt",
      });

      const reloaded = new ConfigStore(dir);
      expect(reloaded.stored().surfacePromptEnabled).toBe(false);
      expect(reloaded.stored().surfacePrompt).toBe("custom wechat prompt");

      const resolved = reloaded.resolve(defaultConfig());
      expect(resolved.surfacePromptEnabled).toBe(false);
      expect(resolved.surfacePrompt).toBe("custom wechat prompt");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops a stored superseded default prompt so the new default applies", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const legacy = LEGACY_SURFACE_PROMPTS[0]!;
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ surfacePromptEnabled: true, surfacePrompt: legacy }),
        "utf-8",
      );

      const store = new ConfigStore(dir);
      expect(store.stored().surfacePrompt).toBeUndefined();
      expect(store.resolve(defaultConfig()).surfacePrompt).toBe(DEFAULT_SURFACE_PROMPT);
      // The enable flag is a real user choice and must survive.
      expect(store.resolve(defaultConfig()).surfacePromptEnabled).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a genuinely edited prompt that merely resembles the default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const edited = DEFAULT_SURFACE_PROMPT + " 另外请用简体中文。";
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ surfacePrompt: edited }),
        "utf-8",
      );

      const store = new ConfigStore(dir);
      expect(store.resolve(defaultConfig()).surfacePrompt).toBe(edited);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-boolean surfacePromptEnabled and non-string surfacePrompt", () => {    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({
        surfacePromptEnabled: "yes" as never,
        surfacePrompt: 12 as never,
      });
      expect(store.stored().surfacePromptEnabled).toBeUndefined();
      expect(store.stored().surfacePrompt).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
