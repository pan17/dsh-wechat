/**
 * Editable WeChat configuration, persisted to `~/.dsh-wechat/config.json`.
 *
 * Merge order (later wins): built-in defaults ← composition `config:` block
 * ← config.json (edited from the Settings page).
 */

import fs from "node:fs";
import path from "node:path";
import { defaultConfig, type WeChatDSHConfig } from "./config.js";

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
>;

const EDITABLE_KEYS: Array<keyof EditableConfig> = [
  "baseUrl",
  "cdnBaseUrl",
  "botType",
  "cwd",
  "textChunkLimit",
  "cardTimeoutMs",
  "crossSessionNotify",
  "notifyTaskEvents",
];

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
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch {
      // fall through to defaults
    }
    return {};
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.overrides, null, 2), "utf-8");
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
