/**
 * Editable WeChat configuration, persisted to `~/.dsh-wechat/config.json`.
 *
 * Merge order (later wins): built-in defaults ← composition `config:` block
 * ← config.json (edited from the Settings page).
 */

import fs from "node:fs";
import path from "node:path";
import {
  defaultConfig,
  LEGACY_SURFACE_PROMPTS,
  normalizeWorkStepsConfig,
  WORK_STEPS_MODES,
  type StatusMode,
  type WeChatDSHConfig,
  type WorkStepsMode,
} from "./config.js";
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
  | "notifyTaskFullReply"
  | "workSteps"
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
  | "mediaMergeEnabled"
  | "mediaHoldMs"
  | "mediaAtRefEnabled"
  | "statusMode"
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
  "notifyTaskFullReply",
  "workSteps",
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
  "mediaMergeEnabled",
  "mediaHoldMs",
  "mediaAtRefEnabled",
  "statusMode",
];

/** Boolean config keys: a non-boolean from a hand-edited file would be truthy-by-accident. */
const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  "surfacePromptEnabled",
  "crossSessionNotify",
  "notifyTaskEvents",
  "notifyTaskFullReply",
  "allowRemotePermissionEscalation",
  "allowAnyFilePath",
  "mergeEnabled",
  "mergeSuffixTokens",
  "mediaMergeEnabled",
  "mediaAtRefEnabled",
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
  "mediaHoldMs",
]);

/**
 * Non-negative number keys: `0` is meaningful and must survive the guard.
 * For `mergeSilenceMs` it means "no merge window" — dispatch immediately,
 * which is also the escape hatch tests and `merge-averse` installs use.
 */
const NON_NEGATIVE_NUMBER_KEYS: ReadonlySet<string> = new Set(["mergeSilenceMs"]);

/**
 * Enum-valued config keys and the exact spellings each accepts.
 *
 * Not a boolean: `statusMode` has two meaningful values today and a third
 * ("stats-only"?) is the obvious next request, while a boolean guard would let
 * a hand-edited `"no"` (truthy!) through and silently mean `"full"`. A value
 * outside this set is dropped, so the built-in default applies.
 */
const ENUM_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ["statusMode", new Set<StatusMode>(["brief", "full"])],
  ["workSteps", new Set<WorkStepsMode>(WORK_STEPS_MODES)],
]);

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
          // One-time migration of the removed silent/finalOnly switches. A
          // valid workSteps wins; otherwise finalOnly=true means minimal,
          // silent=true means concise, and an explicit false means standard.
          // The old keys are deleted so they cannot be round-tripped forever.
          normalizeWorkStepsConfig(parsed as Record<string, unknown>);
          // A stored prompt equal to a superseded built-in default was never
          // edited by the user: drop it so the current default applies.
          if (
            typeof parsed.surfacePrompt === "string"
            && LEGACY_SURFACE_PROMPTS.includes(parsed.surfacePrompt)
          ) {
            delete parsed.surfacePrompt;
          }
          // Keys this version no longer knows are dropped rather than
          // round-tripped forever. A switch that a later version removes would
          // otherwise keep advertising itself in the only file a user can read
          // the effective configuration from, and a future re-add would
          // silently resurrect a stale value.
          for (const key of Object.keys(parsed)) {
            if (!EDITABLE_KEYS.includes(key as keyof EditableConfig)) {
              delete (parsed as Record<string, unknown>)[key];
            }
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
            const allowed = ENUM_KEYS.get(key);
            if (allowed) {
              // A hand-edited `statusMode: "verbose"` would otherwise reach
              // `/status` as an unknown mode and be treated as "not brief",
              // i.e. silently full.
              if (typeof value !== "string" || !allowed.has(value)) {
                delete (parsed as Record<string, unknown>)[key];
              }
            } else if (BOOLEAN_KEYS.has(key) && typeof value !== "boolean") {
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
      const allowed = ENUM_KEYS.get(key);
      if (allowed && (typeof value !== "string" || !allowed.has(value))) continue;
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
