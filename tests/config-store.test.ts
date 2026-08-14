/**
 * Tests for ConfigStore (editable config persistence + merge precedence).
 */

import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { ConfigStore } from "../src/config-store.js";
import { defaultConfig } from "../src/config.js";

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
});
