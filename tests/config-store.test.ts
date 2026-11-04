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

  it("persists workSteps as an enum and rejects anything else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      expect(store.update({ workSteps: "minimal" }).workSteps).toBe("minimal");
      expect(new ConfigStore(dir).stored().workSteps).toBe("minimal");
      expect(new ConfigStore(dir).resolve(defaultConfig()).workSteps).toBe("minimal");

      expect(store.update({ workSteps: "concise" }).workSteps).toBe("concise");
      expect(new ConfigStore(dir).stored().workSteps).toBe("concise");

      // Junk is refused rather than persisted, so the previous value stays.
      expect(store.update({ workSteps: "verbose" as never }).workSteps).toBe("concise");
      expect(store.update({ workSteps: 42 as never }).workSteps).toBe("concise");
      expect(store.update({ workSteps: null as never }).workSteps).toBe("concise");

      expect(store.update({ workSteps: "standard" }).workSteps).toBe("standard");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists the finalOnly windows and rejects non-positive or non-numeric values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({ finalOnlyIdleMs: 15_000, finalOnlyCeilingMs: 120_000 });
      const reloaded = new ConfigStore(dir);
      expect(reloaded.stored().finalOnlyIdleMs).toBe(15_000);
      expect(reloaded.stored().finalOnlyCeilingMs).toBe(120_000);

      store.update({
        finalOnlyIdleMs: 0,
        finalOnlyCeilingMs: Number.NaN,
      });
      expect(new ConfigStore(dir).stored().finalOnlyIdleMs).toBe(15_000);
      expect(new ConfigStore(dir).stored().finalOnlyCeilingMs).toBe(120_000);

      store.update({ finalOnlyIdleMs: "60000" as never, finalOnlyCeilingMs: -1 });
      expect(new ConfigStore(dir).stored().finalOnlyIdleMs).toBe(15_000);
      expect(new ConfigStore(dir).stored().finalOnlyCeilingMs).toBe(120_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults workSteps to standard with a 45s settle window and a 10min ceiling", () => {
    const cfg = defaultConfig();
    expect(cfg.workSteps).toBe("standard");
    expect(cfg.finalOnlyIdleMs).toBe(45_000);
    expect(cfg.finalOnlyCeilingMs).toBe(600_000);
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

  it("persists sendWechatRateLimitPerMinute and accepts 0 as 'unlimited'", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({ sendWechatRateLimitPerMinute: 25 });
      expect(new ConfigStore(dir).stored().sendWechatRateLimitPerMinute).toBe(25);

      store.update({ sendWechatRateLimitPerMinute: 0 });
      expect(new ConfigStore(dir).stored().sendWechatRateLimitPerMinute).toBe(0);

      const reloaded = new ConfigStore(dir);
      expect(reloaded.resolve(defaultConfig()).sendWechatRateLimitPerMinute).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-finite or negative rate limit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({ sendWechatRateLimitPerMinute: 7 });
      // A negative limit would refuse EVERY push, so it is not a valid "off".
      store.update({ sendWechatRateLimitPerMinute: -1 });
      expect(new ConfigStore(dir).stored().sendWechatRateLimitPerMinute).toBe(7);
      store.update({ sendWechatRateLimitPerMinute: Number.NaN });
      expect(new ConfigStore(dir).stored().sendWechatRateLimitPerMinute).toBe(7);
      store.update({ sendWechatRateLimitPerMinute: Number.POSITIVE_INFINITY });
      expect(new ConfigStore(dir).stored().sendWechatRateLimitPerMinute).toBe(7);
      store.update({ sendWechatRateLimitPerMinute: "10" as never });
      expect(new ConfigStore(dir).stored().sendWechatRateLimitPerMinute).toBe(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists allowedUsers as an array of strings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({ allowedUsers: ["wxid_a", "wxid_b"] });
      expect(new ConfigStore(dir).stored().allowedUsers).toEqual(["wxid_a", "wxid_b"]);
      expect(new ConfigStore(dir).resolve(defaultConfig()).allowedUsers).toEqual(["wxid_a", "wxid_b"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-array or non-string-membered allowedUsers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({ allowedUsers: ["wxid_ok"] });
      // A stored list containing a non-string would look non-empty (so the
      // first-user fallback is off) while never matching anyone.
      store.update({ allowedUsers: ["wxid_ok", 42] as never });
      expect(new ConfigStore(dir).stored().allowedUsers).toEqual(["wxid_ok"]);
      store.update({ allowedUsers: "wxid_ok" as never });
      expect(new ConfigStore(dir).stored().allowedUsers).toEqual(["wxid_ok"]);
      store.update({ allowedUsers: { 0: "wxid_ok" } as never });
      expect(new ConfigStore(dir).stored().allowedUsers).toEqual(["wxid_ok"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitises a hand-edited allowedUsers read straight from config.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ allowedUsers: ["wxid_ok", 7, null] }),
        "utf-8",
      );
      const store = new ConfigStore(dir);
      expect(store.stored().allowedUsers).toEqual(["wxid_ok"]);

      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ allowedUsers: "nope" }), "utf-8");
      expect(new ConfigStore(dir).stored().allowedUsers).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults the push governance switches to off / empty", () => {
    const cfg = defaultConfig();
    expect(cfg.sendWechatRateLimitPerMinute).toBe(10);
    expect(cfg.allowedUsers).toEqual([]);
  });

  it("defaults the hardening wave: no escalation, no arbitrary paths, merge off", () => {
    const cfg = defaultConfig();
    // Security defaults must be the restrictive ones.
    expect(cfg.allowRemotePermissionEscalation).toBe(false);
    expect(cfg.allowAnyFilePath).toBe(false);
    expect(cfg.maxOutgoingFileBytes).toBe(20 * 1024 * 1024);
    // 打字合并 is OFF by default: batching changes what "one turn" means and
    // adds a silence window of latency, so it is opt-in. The tuning knobs keep
    // their values so `/merge on` behaves as documented the moment it is used.
    expect(cfg.mergeEnabled).toBe(false);
    expect(cfg.mergeSilenceMs).toBe(3000);
    expect(cfg.mergeMaxMsgs).toBe(10);
    expect(cfg.mergeSuffixTokens).toBe(true);
    expect(cfg.mergeForcedReleaseMs).toBe(180_000);
  });

  it("persists the new booleans and numbers with type guards", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      store.update({
        mergeEnabled: false,
        mergeSuffixTokens: false,
        allowRemotePermissionEscalation: true,
        allowAnyFilePath: true,
        mergeSilenceMs: 0,
        mergeMaxMsgs: 3,
        mergeForcedReleaseMs: 1000,
        maxOutgoingFileBytes: 4096,
      });
      const stored = new ConfigStore(dir).stored();
      expect(stored.mergeEnabled).toBe(false);
      expect(stored.allowAnyFilePath).toBe(true);
      // 0 = "no merge window" is meaningful and must survive.
      expect(stored.mergeSilenceMs).toBe(0);
      expect(stored.mergeMaxMsgs).toBe(3);
      expect(stored.maxOutgoingFileBytes).toBe(4096);

      // Junk is refused rather than persisted.
      store.update({ mergeEnabled: "yes" as never, mergeSilenceMs: -1 as never, maxOutgoingFileBytes: 0 as never });
      const after = new ConfigStore(dir).stored();
      expect(after.mergeEnabled).toBe(false);
      expect(after.mergeSilenceMs).toBe(0);
      expect(after.maxOutgoingFileBytes).toBe(4096);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitises hand-edited hardening keys read straight from config.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
        mergeEnabled: "no",
        allowAnyFilePath: 1,
        maxOutgoingFileBytes: "4096",
        mergeSilenceMs: null,
        mergeMaxMsgs: 5,
      }), "utf-8");
      const stored = new ConfigStore(dir).stored();
      // Malformed values are dropped so the built-in default applies; a
      // truthy string must never switch a security default on.
      expect(stored.mergeEnabled).toBeUndefined();
      expect(stored.allowAnyFilePath).toBeUndefined();
      expect(stored.maxOutgoingFileBytes).toBeUndefined();
      expect(stored.mergeSilenceMs).toBeUndefined();
      expect(stored.mergeMaxMsgs).toBe(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults 图片/文件合并 to off, with a 3-minute attachment wait and plain-path delivery", () => {
    const cfg = defaultConfig();
    // Off by default: holding an attachment for a sentence that never arrives
    // is indistinguishable from a dropped message, so it is opt-in.
    expect(cfg.mediaMergeEnabled).toBe(false);
    // Plain path by default: the `@文件` chip only renders when the host has
    // `dsh-file-reference` mounted, and an unparsed mention shows a raw `@C:/…`.
    // `/media at` opts into the chip; either way the prompt is a pointer.
    expect(cfg.mediaAtRefEnabled).toBe(false);
    // 3 minutes — the same as the merge window's forced release, i.e. the
    // longest a turn may be held at all. `mediaHoldMs()` takes the shorter of
    // the two, so this default is exactly the ceiling rather than under it.
    expect(cfg.mediaHoldMs).toBe(180_000);
    expect(cfg.mediaHoldMs).toBe(cfg.mergeForcedReleaseMs);
  });

  it("persists the 图片/文件 switches with the same type guards as the merge ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      // `true` on purpose: it is NOT the default, so reading it back proves the
      // value round-tripped instead of falling through to `defaultConfig()`.
      store.update({ mediaMergeEnabled: true, mediaAtRefEnabled: true, mediaHoldMs: 15_000 });
      const stored = new ConfigStore(dir).stored();
      expect(stored.mediaMergeEnabled).toBe(true);
      expect(stored.mediaAtRefEnabled).toBe(true);
      expect(stored.mediaHoldMs).toBe(15_000);

      // Junk is refused rather than persisted — a truthy string must never
      // switch the hold on, and a `"60"` wait would compare as a string.
      store.update({
        mediaMergeEnabled: "yes" as never,
        mediaAtRefEnabled: 1 as never,
        mediaHoldMs: "60000" as never,
      });
      const after = new ConfigStore(dir).stored();
      expect(after.mediaMergeEnabled).toBe(true);
      expect(after.mediaAtRefEnabled).toBe(true);
      expect(after.mediaHoldMs).toBe(15_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitises hand-edited 图片/文件 keys read straight from config.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
        mediaMergeEnabled: "on",
        mediaAtRefEnabled: 0,
        mediaHoldMs: -5,
      }), "utf-8");
      const stored = new ConfigStore(dir).stored();
      // Dropped, so the built-in defaults (off / 纯路径 / 180000) apply — a
      // hand-edited "on" must not silently enable the hold.
      expect(stored.mediaMergeEnabled).toBeUndefined();
      expect(stored.mediaAtRefEnabled).toBeUndefined();
      expect(stored.mediaHoldMs).toBeUndefined();
      const resolved = new ConfigStore(dir).resolve(defaultConfig());
      expect(resolved.mediaMergeEnabled).toBe(false);
      expect(resolved.mediaAtRefEnabled).toBe(false);
      expect(resolved.mediaHoldMs).toBe(180_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists statusMode as an enum and rejects anything else", () => {
    // `statusMode` is not a boolean: it has exactly two spellings, and a
    // hand-edited `"verbose"` must not reach `/status` as an unknown mode
    // (which every comparison would read as "not brief", i.e. silently full).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      const store = new ConfigStore(dir);
      expect(store.update({ statusMode: "full" }).statusMode).toBe("full");
      expect(new ConfigStore(dir).stored().statusMode).toBe("full");

      // Junk is refused rather than persisted, so the previous value stays.
      expect(store.update({ statusMode: "verbose" as never }).statusMode).toBe("full");
      expect(store.update({ statusMode: 42 as never }).statusMode).toBe("full");
      expect(store.update({ statusMode: null as never }).statusMode).toBe("full");

      // And back to brief.
      expect(store.update({ statusMode: "brief" }).statusMode).toBe("brief");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults statusMode to brief and sanitises a hand-edited file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      expect(defaultConfig().statusMode).toBe("brief");

      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
        statusMode: "verbose",
        legacyStatusSwitch: true,
      }), "utf-8");
      const store = new ConfigStore(dir);
      // Both dropped on load, so the built-in defaults apply.
      expect(store.stored()).toEqual({});
      expect(store.resolve(defaultConfig()).statusMode).toBe("brief");

      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ statusMode: "full" }), "utf-8");
      expect(new ConfigStore(dir).resolve(defaultConfig()).statusMode).toBe("full");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops keys this version no longer knows instead of round-tripping them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
    try {
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
        // A switch from a hypothetical other version: unknown here, so it must
        // not survive (the file is the only place a user can read the effective
        // config, and a future re-add must not resurrect a stale value).
        legacyMediaSwitch: false,
        statusMode: "full",
      }), "utf-8");
      const store = new ConfigStore(dir);
      expect(store.stored()).toEqual({ statusMode: "full" });
      // Still gone after the next write — not resurrected by the round-trip.
      store.update({ mediaHoldMs: 30_000 });
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8")) as Record<string, unknown>;
      expect(onDisk).toEqual({ statusMode: "full", mediaHoldMs: 30_000 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates silent/finalOnly on load and deletes the legacy keys", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ finalOnly: true }, "minimal"],
      [{ silent: true }, "concise"],
      [{ silent: true, finalOnly: true }, "minimal"],
      [{ silent: false, finalOnly: false }, "standard"],
      [{ workSteps: "concise", finalOnly: true }, "concise"],
      [{ workSteps: "junk", silent: true }, "concise"],
      [{ workSteps: "junk" }, "standard"],
    ];
    for (const [raw, expected] of cases) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-cfg-"));
      try {
        fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(raw), "utf-8");
        const store = new ConfigStore(dir);
        expect(store.resolve(defaultConfig()).workSteps).toBe(expected);
        expect(store.stored().silent).toBeUndefined();
        expect(store.stored().finalOnly).toBeUndefined();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
