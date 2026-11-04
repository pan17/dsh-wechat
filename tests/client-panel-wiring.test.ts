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
 * renders, plus the work-steps enum specifically.
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
  // 完成提醒带全文还是摘要 (gated by notifyTaskEvents, default摘要).
  "notifyTaskFullReply",
  "surfacePromptEnabled",
  // Hardening wave: the merge window and the two security switches.
  "mergeEnabled",
  "mergeSuffixTokens",
  "allowRemotePermissionEscalation",
  "allowAnyFilePath",
  // 图片/文件合并 + 附件交付措辞 (the wording switch changes no content).
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

  it("the 工作步骤展示 control is a labelled three-mode dropdown", () => {
    expect(client).toContain("工作步骤展示");
    expect(client).not.toContain("选择希望看到多少工具调用细节");
    expect(client).not.toContain("wx_setting_desc");
    expect(client).toContain("极简");
    expect(client).toContain("简洁");
    expect(client).toContain("标准");
    expect(client).toContain("role: \"listbox\"");
    expect(client).toContain("role: \"option\"");
    expect(client).toContain("aria-selected");
    expect(client).toContain("wx_select_menu");
    expect(client).toContain("wx_select_check");
    expect(client).toContain("/steps 极简|简洁|标准");
    // Each option explains itself on hover/focus via the shared portal
    // tooltip (the menu's overflow:hidden would clip a child bubble).
    expect(client).toContain("一般用于 goal 多轮任务");
    expect(client).toContain("每轮只发送最后一段回复");
    expect(client).toContain("显示执行过程和最终回复");
    expect(client).toContain("placeHelpFloat(e.currentTarget, option.description)");
    expect(client).toContain("onMouseEnter: (e) => placeHelpFloat");
    expect(client).toContain("onMouseLeave: removeHelpFloat");
    expect(client).toContain("/flush");
    // The old checkbox controls and their commands are gone.
    expect(client).not.toContain("form?.silent");
    expect(client).not.toContain("form?.finalOnly");
    expect(client).not.toContain("/silent");
    expect(client).not.toContain("/final");
  });

  it("initialises, renders and saves workSteps as an enum", () => {
    expect(EDITABLE_KEYS as readonly string[]).toContain("workSteps");
    expect(defaultConfig().workSteps).toBe("standard");
    expect(client).toContain("r.body.config?.workSteps");
    expect(client).toContain("value: form?.workSteps");
    expect(client).toContain("setForm({ ...form, workSteps: value })");
    expect(client).toContain("workSteps: normalizeWorkSteps(form.workSteps)");
    expect(client).toContain("function normalizeWorkSteps(value)");
    // The summary line must mention it, or a collapsed group hides it.
    expect(client).toContain("工作步骤 ${workStepsLabel(form.workSteps)}");
    // The old merge blurb was removed on request; the row and its HelpTip
    // carry the explanation instead.
    expect(client).not.toContain("原来的「静默」「结论模式」合并");
  });

  it("the 打字合并 control points at the WeChat-side switch", () => {
    expect(client).toContain("打字合并");
    expect(client).toContain("/merge on|off");
    // The suffix tokens are the reason the feature is usable at all; the
    // panel has to document them.
    expect(client).toContain("`..`");
    expect(client).toContain("`!!`");
  });

  // `statusMode` is an ENUM, not a checkbox: it has its own silent-failure
  // modes (a radio that never initialises renders "brief" over a stored
  // "full", and a payload that forgets the key leaves the old value behind).
  it("statusMode is initialised, rendered and saved as an enum", () => {
    expect(client).toContain("r.body.config?.statusMode");
    // Radios, not checkboxes — the two options are exclusive.
    expect(client).toContain('type: "radio", name: "statusMode"');
    expect(client).toContain('setForm({ ...form, statusMode: "brief" })');
    expect(client).toContain('setForm({ ...form, statusMode: "full" })');
    expect(client).toContain('statusMode: form.statusMode === "full" ? "full" : "brief"');
    // Both spellings are offered, and the WeChat-side switch is documented.
    expect(client).toContain("简洁");
    expect(client).toContain("详细");
    expect(client).toContain("/status brief|full");
    // The summary line has to mention it, or a collapsed group hides the
    // setting entirely.
    expect(client).toContain('form.statusMode === "full" ? "详细" : "简洁"');
    expect((EDITABLE_KEYS as readonly string[]).includes("statusMode")).toBe(true);
    expect(defaultConfig().statusMode).toBe("brief");
  });

  it("statusMode lives in the delivery group, not a seventh group", () => {
    // The panel is pinned at six groups (the grouping test below counts the
    // `createElement(Group, {` calls); a new enum must join an existing one.
    const deliveryStart = client.indexOf('id: "delivery"');
    const mergeStart = client.indexOf('id: "merge"');
    expect(deliveryStart).toBeGreaterThan(-1);
    expect(mergeStart).toBeGreaterThan(deliveryStart);
    expect(client.slice(deliveryStart, mergeStart)).toContain('name: "statusMode"');
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
      expect(store.update({ mergeEnabled: true }).mergeEnabled).toBe(true);
      expect(store.update({ mergeEnabled: "nope" as never }).mergeEnabled).toBe(true);
      expect(new ConfigStore(dir).stored().mergeEnabled).toBe(true);
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
    // Same guard for the attachment feature: its switch and its only number
    // must live in ONE place, or "where do I turn this on?" becomes a hunt
    // through five collapsed groups.
    const mediaStart = client.indexOf('id: "media"');
    const promptStart = client.indexOf('id: "prompt"');
    expect(mediaStart).toBeGreaterThan(-1);
    expect(promptStart).toBeGreaterThan(mediaStart);
    const mediaGroup = client.slice(mediaStart, promptStart);

    expect(mediaGroup).toContain("form?.mediaMergeEnabled");
    expect(mediaGroup).toContain("form?.mediaAtRefEnabled");
    expect(mediaGroup).toContain("value: form.mediaHoldMs");

    // Nothing of it may leak into an earlier group.
    const before = client.slice(0, mediaStart);
    expect(before).not.toContain("value: form.mediaHoldMs");
    expect(before).not.toContain("form?.mediaAtRefEnabled");

    // The panel must document the WeChat-side switches, like every other
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
    // The wording switch is NOT gated: it applies to every attachment, held or
    // not, so it must stay clickable with the hold off.
    expect(client.match(/disabled: !form\?\.mediaMergeEnabled/g)?.length).toBe(1);
    expect(client).not.toContain("disabled: !form?.mediaAtRefEnabled");
    expect(client).toContain("mediaSummary");
  });

  it("the 完整显示任务完成回复 switch is inert until 跨会话任务完成提醒 is on", () => {
    // Same rule as the merge parameters: disabled, never hidden. Its own
    // render path decides nothing while the notice gate is off, so leaving it
    // clickable would advertise a switch that currently does nothing.
    expect(client).toContain("disabled: !form?.notifyTaskEvents");
    // It must live in the delivery group, right with the gate it depends on.
    const deliveryStart = client.indexOf('id: "delivery"');
    const mergeStart = client.indexOf('id: "merge"');
    const delivery = client.slice(deliveryStart, mergeStart);
    expect(delivery).toContain("form?.notifyTaskEvents");
    expect(delivery).toContain("form?.notifyTaskFullReply");
    // The collapsed summary must show the choice, or the setting disappears
    // the moment the group is closed.
    expect(client).toContain('? "全文" : "摘要"');
  });

  it("attaches the 完整显示 switch to its parent toggle in the SAME grid cell", () => {
    // The delivery toggles are a TWO-COLUMN grid filled row by row. Two ways to
    // get this wrong, and both were shipped before the screenshot caught them:
    //
    //   1. a bare sibling cell      → it lands left, a row below the parent;
    //   2. `grid-column:1 / -1`     → it spans the row, but STILL starts on the
    //                                 next line, so it reads as a child of the
    //                                 left-hand neighbour instead.
    //
    // The only shape that keeps it under «跨会话任务完成提醒» is one wrapper
    // `.wx_cell` containing BOTH the parent label and the `.wx_dep` block, so
    // the pair occupies a single grid cell.
    const cellAt = client.indexOf('className: "wx_cell"');
    const parentAt = client.indexOf("checked: !!form?.notifyTaskEvents");
    const depAt = client.indexOf('className: "wx_dep"');
    const fullAt = client.indexOf("checked: !!form?.notifyTaskFullReply");
    expect(cellAt).toBeGreaterThan(-1);
    // Order inside the cell: wrapper → parent label → dep block → child input.
    expect(parentAt).toBeGreaterThan(cellAt);
    expect(depAt).toBeGreaterThan(parentAt);
    expect(fullAt).toBeGreaterThan(depAt);
    // The wrapper must close AFTER the dependent switch, or the child escapes
    // its cell again (slice runs to the next toggle that follows the pair).
    const nextControlAt = client.indexOf('name: "statusMode"');
    expect(nextControlAt).toBeGreaterThan(fullAt);
    const cellSource = client.slice(cellAt, nextControlAt);
    expect(cellSource).toContain("checked: !!form?.notifyTaskFullReply");
    // The span-the-whole-row hack must be GONE — it was the actual bug.
    expect(client).not.toContain(".wx_dep{grid-column:1 / -1;");
    expect(client).toContain(".wx_cell{display:flex;flex-direction:column;min-width:0}");
    // The inline dependency hint was removed to save space; the child's
    // HelpTip still explains the gating.
    expect(client).not.toContain("仅在「跨会话任务完成提醒」开启时生效");
    expect(client).not.toContain("wx_dep_hint");
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
