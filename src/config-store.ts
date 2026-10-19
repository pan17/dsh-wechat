/**
 * Editable WeChat configuration, persisted to `~/.dsh-wechat/config.json`.
 *
 * Merge order (later wins): built-in defaults ← composition `config:` block
 * ← config.json (edited from the Settings page).
 */

import fs from "node:fs";
import path from "node:path";
import { defaultConfig, LEGACY_SURFACE_PROMPTS, type WeChatDSHConfig } from "./config.js";
import { ensurePrivateDir, writePrivateFile } from "./utils/secure-fs.js";

export type EditableConfig = Pick<
  WeChatDSHConfig,
  | "baseUrl"
  | "cdnBaseUrl"
  | "botType"
  | "cwd"
  | "textChunkLimit"
  | "cardTimeoutMs"
  | "crossSessionNotify"
  | "notifyTaskEvents"
  | "silent"
  | "finalOnly"
  | "finalOnlyIdleMs"
  | "finalOnlyCeilingMs"
  | "surfacePromptEnabled"
  | "surfacePrompt"
  | "sendWechatRateLimitPerMinute"
  | "allowedUsers"
  | "allowRemotePermissionEscalation"
  | "allowAnyFilePath"
  | "maxOutgoingFileBytes"
  | "mergeEnabled"
  | "mergeSilenceMs"
  | "mergeMaxMsgs"
  | "mergeSuffixTokens"
  | "mergeForcedReleaseMs"
>;

export const EDITABLE_KEYS: Array<keyof EditableConfig> = [
  "baseUrl",
  "cdnBaseUrl",
  "botType",
  "cwd",
  "textChunkLimit",
  "cardTimeoutMs",
  "crossSessionNotify",
  "notifyTaskEvents",
  "silent",
  "finalOnly",
  "finalOnlyIdleMs",
  "finalOnlyCeilingMs",
  "surfacePromptEnabled",
  "surfacePrompt",
  "sendWechatRateLimitPerMinute",
  "allowedUsers",
  "allowRemotePermissionEscalation",
  "allowAnyFilePath",
  "maxOutgoingFileBytes",
  "mergeEnabled",
  "mergeSilenceMs",
  "mergeMaxMsgs",
  "mergeSuffixTokens",
  "mergeForcedReleaseMs",
];

/** Boolean config keys: a non-boolean from a hand-edited file would be truthy-by-accident. */
const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  "surfacePromptEnabled",
  "silent",
  "crossSessionNotify",
  "notifyTaskEvents",
  "finalOnly",
  "allowRemotePermissionEscalation",
  "allowAnyFilePath",
  "mergeEnabled",
  "mergeSuffixTokens",
]);

/**
 * Positive-number config keys. The guard rejects anything that cannot
 * describe the value at all (non-numeric, non-finite, ≤ 0) so a malformed
 * file cannot silently disable a bound or a timeout.
 */
const POSITIVE_NUMBER_KEYS: ReadonlySet<string> = new Set([
  "finalOnlyIdleMs",
  "finalOnlyCeilingMs",
  "maxOutgoingFileBytes",
  "mergeMaxMsgs",
  "mergeForcedReleaseMs",
]);

/**
 * Non-negative number keys: `0` is meaningful and must survive the guard.
 * For `mergeSilenceMs` it means "no merge window" — dispatch immediately,
 * which is also the escape hatch tests and `merge-averse` installs use.
 */
const NON_NEGATIVE_NUMBER_KEYS: ReadonlySet<string> = new Set(["mergeSilenceMs"]);

export class ConfigStore {
  private readonly filePath: string;
  private overrides: Partial<EditableConfig> = {};

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, "config.json");
    this.overrides = this.load();
  }

  private load(): Partial<EditableConfig> {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<EditableConfig>;
        if (parsed && typeof parsed === "object") {
          // A stored prompt equal to a superseded built-in default was never
          // edited by the user: drop it so the current default applies.
          if (
            typeof parsed.surfacePrompt === "string"
            && LEGACY_SURFACE_PROMPTS.includes(parsed.surfacePrompt)
          ) {
            delete parsed.surfacePrompt;
          }
          // A hand-edited `config.json` bypasses `update()`'s guards, and the
          // inbound allowlist is compared against every message: keeping a
          // non-string member would make the list look non-empty (so the
          // first-user fallback is off) while never matching anyone.
          if (parsed.allowedUsers !== undefined) {
            if (Array.isArray(parsed.allowedUsers)) {
              parsed.allowedUsers = parsed.allowedUsers.filter((id): id is string => typeof id === "string");
            } else {
              delete parsed.allowedUsers;
            }
          }
          // Same reasoning for the typed switches this version added: a
          // hand-edited `mergeEnabled: "no"` is a truthy string, and a
          // `maxOutgoingFileBytes: "20"` would compare every file as too big.
          // A malformed value is dropped, so the built-in default applies.
          for (const key of Object.keys(parsed)) {
            const value = (parsed as Record<string, unknown>)[key];
            if (value === undefined) continue;
            if (BOOLEAN_KEYS.has(key) && typeof value !== "boolean") {
              delete (parsed as Record<string, unknown>)[key];
            } else if (POSITIVE_NUMBER_KEYS.has(key) && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
              delete (parsed as Record<string, unknown>)[key];
            } else if (NON_NEGATIVE_NUMBER_KEYS.has(key) && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
              delete (parsed as Record<string, unknown>)[key];
            }
          }
          return parsed;
        }
      }
    } catch {
      // fall through to defaults
    }
    return {};
  }

  private save(): void {
    ensurePrivateDir(path.dirname(this.filePath));
    // 0o600: this file names the storage layout and can hold a custom surface
    // prompt, and (from this version) the inbound allowlist.
    writePrivateFile(this.filePath, JSON.stringify(this.overrides, null, 2));
  }

  /** Resolve the effective config: composition defaults overridden by stored values. */
  resolve(base: WeChatDSHConfig): WeChatDSHConfig {
    const out: WeChatDSHConfig = { ...base };
    for (const key of EDITABLE_KEYS) {
      const value = this.overrides[key];
      if (value !== undefined) {
        (out as unknown as Record<string, unknown>)[key] = value;
      }
    }
    return out;
  }

  /** Apply a patch and persist it. Returns the new effective overrides. */
  update(patch: Partial<EditableConfig>): Partial<EditableConfig> {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (!(EDITABLE_KEYS as string[]).includes(key)) continue;
      if (BOOLEAN_KEYS.has(key) && typeof value !== "boolean") continue;
      if (POSITIVE_NUMBER_KEYS.has(key) && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) continue;
      if (NON_NEGATIVE_NUMBER_KEYS.has(key) && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) continue;
      // 0 is meaningful here (unlimited), so the guard only rejects a value
      // that cannot describe a rate at all: non-numeric, non-finite or
      // negative. A negative limit would refuse EVERY push.
      if (key === "sendWechatRateLimitPerMinute" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) continue;
      // The allowlist gates inbound processing, so a malformed value must
      // not be stored: `["u1", 42]` would compare against a number forever.
      if (key === "allowedUsers" && (!Array.isArray(value) || value.some((id) => typeof id !== "string"))) continue;
      if (key === "surfacePrompt" && typeof value !== "string") continue;
      (this.overrides as Record<string, unknown>)[key] = value;
    }
    this.save();
    return { ...this.overrides };
  }

  /** The raw stored overrides (for display in the settings page). */
  stored(): Partial<EditableConfig> {
    return { ...this.overrides };
  }
}
