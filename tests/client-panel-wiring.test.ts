/**
 * Settings-panel wiring guard.
 *
 * `src/client.js` is a plain-JS bundle with no test coverage, and every way a
 * new config key can be half-wired fails SILENTLY — the checkbox renders, the
 * save returns `{ok:true}`, and nothing is persisted (this exact bug shipped
 * once; see CHANGELOG 0.8.x "设置页「静默」在重新扫码后被取消勾选"):
 *
 *   - missing from the form init (`setForm({…})`) ⇒ renders off on load
 *   - missing from the `saveConfig` POST body   ⇒ the save sends nothing
 *   - missing from the JSX                      ⇒ no control at all
 *
 * The host side is equally quiet: `EDITABLE_KEYS` drops unknown keys without
 * an error, and the boolean type-guard silently refuses a non-boolean.
 * These assertions pin the two sides together for every toggle the panel
 * renders, plus 结论模式 specifically.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EDITABLE_KEYS, ConfigStore } from "../src/config-store.js";
import { defaultConfig } from "../src/config.js";

const client = readFileSync(fileURLToPath(new URL("../src/client.js", import.meta.url)), "utf8");

/** Every toggle the WeChat panel renders as a checkbox. */
const RENDERED_TOGGLES = [
  "crossSessionNotify",
  "notifyTaskEvents",
  "silent",
  "finalOnly",
  "surfacePromptEnabled",
  // Hardening wave: the merge window and the two security switches.
  "mergeEnabled",
  "mergeSuffixTokens",
  "allowRemotePermissionEscalation",
  "allowAnyFilePath",
  // 图片/文件合并 + 附件交付方式.
  "mediaMergeEnabled",
  "mediaAtRefEnabled",
] as const;

describe("settings panel ↔ host config wiring", () => {
  it.each(RENDERED_TOGGLES)("%s is an editable config key", (key) => {
    expect(EDITABLE_KEYS as readonly string[]).toContain(key);
    expect(defaultConfig()).toHaveProperty(key);
  });

  it.each(RENDERED_TOGGLES)("%s has a checkbox bound to the form state", (key) => {
    expect(client).toContain(`checked: !!form?.${key}`);
    expect(client).toContain(`setForm({ ...form, ${key}: e.target.checked })`);
  });

  it.each(RENDERED_TOGGLES)("%s is initialised from the server config", (key) => {
    expect(client).toContain(`r.body.config?.${key}`);
  });

  it.each(RENDERED_TOGGLES)("%s is included in the save payload", (key) => {
    expect(client).toContain(`${key}: !!form.${key}`);
  });

  it("the 结论模式 control is labelled and explained to the user", () => {
    expect(client).toContain("结论模式");
    expect(client).toContain("/flush");
    // The panel must point at the WeChat-side switch too: a user who only
    // reads the settings page would otherwise never learn `/final` exists.
    expect(client).toContain("/final on|off");
  });

  it("the 打字合并 control points at the WeChat-side switch", () => {
    expect(client).toContain("打字合并");
    expect(client).toContain("/merge on|off");
    // The suffix tokens are the reason the feature is usable at all; the
    // panel has to document them.
    expect(client).toContain("`..`");
    expect(client).toContain("`!!`");
  });

  // The two text/number fields have their own silent-failure modes, so they are
  // guarded the same way the checkboxes are: a field that is missing from the
  // form init renders empty, and one missing from the save payload sends
  // nothing while the panel still reports success.
  it.each([
    "sendWechatRateLimitPerMinute",
    "allowedUsers",
    // Hardening wave: the merge parameters and the outgoing-file size cap.
    "mergeSilenceMs",
    "mergeMaxMsgs",
    "mergeForcedReleaseMs",
    "maxOutgoingFileBytes",
    // 图片/文件合并: the attachment wait.
    "mediaHoldMs",
  ])(
    "%s is initialised, rendered and saved",
    (key) => {
      expect(client).toContain(`r.body.config?.${key}`);
      expect(client).toContain(`value: form.${key}`);
      expect(client).toContain(`${key}:`);
      expect((EDITABLE_KEYS as readonly string[]).includes(key)).toBe(true);
    },
  );

  it("accepts both the numeric limit and the allowlist through the store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-panel-"));
    try {
      const store = new ConfigStore(dir);
      expect(store.update({ sendWechatRateLimitPerMinute: 5 }).sendWechatRateLimitPerMinute).toBe(5);
      expect(store.update({ allowedUsers: ["wxid_a", "wxid_b"] }).allowedUsers).toEqual(["wxid_a", "wxid_b"]);
      // 0 is meaningful (= unlimited), so it must NOT be rejected as falsy.
      expect(store.update({ sendWechatRateLimitPerMinute: 0 }).sendWechatRateLimitPerMinute).toBe(0);
      // Junk is refused rather than persisted.
      expect(store.update({ sendWechatRateLimitPerMinute: -1 }).sendWechatRateLimitPerMinute).toBe(0);
      expect(store.update({ allowedUsers: ["ok", 7] as never }).allowedUsers).toEqual(["wxid_a", "wxid_b"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a plain boolean round-trips through the store the panel posts to", () => {
    // The store's boolean guard is an explicit allow-list; a key missing from
    // it accepts junk silently instead of rejecting it. Uses a throwaway
    // storage dir — NEVER the real `~/.dsh-wechat`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wechat-panel-"));
    try {
      const store = new ConfigStore(dir);
      expect(store.update({ finalOnly: true }).finalOnly).toBe(true);
      expect(store.update({ finalOnly: "nope" as never }).finalOnly).toBe(true);
      expect(new ConfigStore(dir).stored().finalOnly).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Grouping guard.
 *
 * The panel used to be one flat card with fifteen controls, which meant the
 * 打字合并 switch and its three window parameters — one feature, five
 * controls — were scattered across two different blocks. These assertions pin
 * the grouping, because "the fields still exist somewhere" is exactly what a
 * bad refactor leaves behind: every control keeps rendering while the feature
 * it belongs to is impossible to find.
 */
describe("settings panel grouping", () => {
  /** Group ids the panel renders, in source order. */
  const GROUPS = ["connection", "delivery", "merge", "media", "prompt", "security"] as const;

  it.each(GROUPS)("renders a %s group", (id) => {
    expect(client).toContain(`id: "${id}"`);
  });

  it("every group carries a title and a live summary", () => {
    // A collapsed group is only readable through its summary, so each Group
    // call must pass one; a missing summary would collapse to a bare title.
    const calls = client.split("createElement(Group, {").slice(1);
    expect(calls.length).toBe(GROUPS.length);
    for (const call of calls) {
      expect(call).toContain("title:");
      expect(call).toContain("summary:");
      expect(call).toContain("onToggle: toggleGroup");
    }
  });

  it("the 打字合并 switch and all of its parameters share one group", () => {
    // Slice the merge group's source region: from its Group call to the next
    // group's. Every merge key must fall inside, and none may leak into a
    // sibling — that leak is what made the feature hard to find.
    const mergeStart = client.indexOf('id: "merge"');
    const mediaStart = client.indexOf('id: "media"');
    expect(mergeStart).toBeGreaterThan(-1);
    expect(mediaStart).toBeGreaterThan(mergeStart);
    const mergeGroup = client.slice(mergeStart, mediaStart);

    for (const key of ["mergeEnabled", "mergeSuffixTokens"]) {
      expect(mergeGroup).toContain(`form?.${key}`);
    }
    for (const key of ["mergeSilenceMs", "mergeMaxMsgs", "mergeForcedReleaseMs"]) {
      expect(mergeGroup).toContain(`value: form.${key}`);
    }

    // The three window parameters must not be RENDERED before the merge
    // group: they belong to it and nowhere else. (`payloadOf` mentions them
    // earlier on purpose — that is the save payload, not a control.)
    const before = client.slice(0, mergeStart);
    expect(before).not.toContain("value: form.mergeSilenceMs");
    expect(before).not.toContain("value: form.mergeMaxMsgs");
    expect(before).not.toContain("value: form.mergeForcedReleaseMs");
  });

  it("the 图片与文件 switch and its parameters share one group, ahead of the prompt group", () => {
    // Same guard for the attachment feature: its two switches and its only
    // number must live in ONE place, or "where do I turn this on?" becomes a
    // hunt through five collapsed groups.
    const mediaStart = client.indexOf('id: "media"');
    const promptStart = client.indexOf('id: "prompt"');
    expect(mediaStart).toBeGreaterThan(-1);
    expect(promptStart).toBeGreaterThan(mediaStart);
    const mediaGroup = client.slice(mediaStart, promptStart);

    for (const key of ["mediaMergeEnabled", "mediaAtRefEnabled"]) {
      expect(mediaGroup).toContain(`form?.${key}`);
    }
    expect(mediaGroup).toContain("value: form.mediaHoldMs");

    // Nothing of it may leak into an earlier group.
    const before = client.slice(0, mediaStart);
    expect(before).not.toContain("value: form.mediaHoldMs");
    expect(before).not.toContain("form?.mediaAtRefEnabled");

    // The panel must document the WeChat-side switch, like every other
    // feature's help text does.
    expect(mediaGroup).toContain("/media on|off");
    expect(mediaGroup).toContain("/media at|path");
  });

  it("the merge parameters are inert until the feature is switched on", () => {
    // Disabled, not hidden: the stored values stay visible and are still
    // submitted, so turning the feature off never loses a tuned window.
    for (const key of ["mergeSilenceMs", "mergeMaxMsgs", "mergeForcedReleaseMs"]) {
      expect(client).toContain(`value: form.${key}`);
    }
    expect(client.match(/disabled: !form\?\.mergeEnabled/g)?.length).toBe(4);
  });

  it("the attachment wait is inert until 图片/文件合并 is switched on", () => {
    // `mediaAtRefEnabled` is NOT gated: the delivery style applies to every
    // attachment, held or not, so it must stay clickable with the hold off.
    expect(client.match(/disabled: !form\?\.mediaMergeEnabled/g)?.length).toBe(1);
    expect(client).not.toContain("disabled: !form?.mediaAtRefEnabled");
    expect(client).toContain("mediaSummary");
  });

  it("remembers which groups are expanded, without requiring storage", () => {
    expect(client).toContain('"dsh-wechat/settings-open"');
    // Private mode / quota must degrade to "toggles but forgets", not throw.
    expect(client).toContain("window.localStorage");
    expect(client).toContain("catch (e) {");
  });

  it("marks unsaved edits against the payload Save would send", () => {
    // The dirty marker compares `payloadOf(form)` with the last confirmed
    // baseline — comparing raw form state instead would flag a reformatted
    // but semantically identical value as dirty.
    expect(client).toContain("function payloadOf(form)");
    expect(client).toContain("JSON.stringify(payloadOf(form))");
    expect(client).toContain("有未保存的修改");
    // One payload builder means the panel cannot post a different shape than
    // the one it measured.
    expect(client.match(/payloadOf\(form\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("every class the panel renders has a rule in its stylesheet", () => {
    // A typo in a className is invisible: the element renders unstyled and
    // the grouping silently loses its header styling. Catch it statically.
    const defined = new Set(
      // A class may be defined as a descendant selector (`.wx_qr img{…}`),
      // so the lookahead accepts a combinator as well as `{`.
      Array.from(client.matchAll(/\.(wx_[a-z_]+)(?=[\s,{:.])/g), (m) => m[1]!),
    );
    const used = new Set(
      Array.from(client.matchAll(/className: "([^"]+)"/g), (m) => m[1]!.split(/\s+/))
        .flat()
        .filter((name) => name.startsWith("wx_")),
    );
    expect(used.size).toBeGreaterThan(20);
    for (const name of used) expect(defined.has(name)).toBe(true);
  });
});
