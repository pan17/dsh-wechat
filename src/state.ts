/**
 * Durable per-user bridge state: session mapping, silent mode, and workspace
 * choices. The default preset deliberately lives in the DSH settings
 * document (`agent-presets` namespace), not here — the GUI settings page and
 * WeChat's `/preset switch` share that one source of truth.
 *
 * Mirrors the reference project's UserState (wechat-opencode) but keeps
 * ONLY what the DSH bridge needs. Persisted to `~/.dsh-wechat/state.json`
 * so restarts restore the WeChat user → DSH session mapping.
 */

import fs from "node:fs";
import path from "node:path";

export interface UserState {
  /** The WeChat user id this state belongs to. */
  userId: string;
  /** Bound DSH session id. */
  sessionId: string;
  /** Working directory the bound session was created with. */
  cwd: string;
  /**
    * Whether the user explicitly switched workspaces (/workspace, /session
    * switch). Explicit choices are NOT overwritten by the settings-page cwd
    * default; users without this flag follow the settings default.
    */
  cwdExplicit?: boolean;
  /** Silent mode: only send the final text of each turn. */
  silent: boolean;
  /** Cross-session notification preference (default inherit -> follows global config). */
  crossSessionNotify?: "inherit" | "on" | "off";
  /** Sessions this user has ever been bound to — used for cross-session recipient resolution. */
  watchedSessions?: string[];
}

export interface BridgeStateFile {
  users: Record<string, UserState>;
}

export class StateStore {
  private readonly filePath: string;
  private state: BridgeStateFile;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, "state.json");
    this.state = this.load();
  }

  private load(): BridgeStateFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as BridgeStateFile;
        if (parsed && typeof parsed === "object" && parsed.users) {
          // Normalize legacy files: ensure optional fields have safe defaults
          for (const user of Object.values(parsed.users)) {
            if (!Array.isArray(user.watchedSessions)) {
              // Seed history with current binding so old users get at least their present session
              user.watchedSessions = user.sessionId ? [user.sessionId] : [];
            }
            if (user.crossSessionNotify !== "on" && user.crossSessionNotify !== "off") {
              user.crossSessionNotify = "inherit";
            }
          }
          return parsed;
        }
      }
    } catch {
      // fall through to fresh state
    }
    return { users: {} };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  ensureUser(userId: string, cwd: string): UserState {
    let user = this.state.users[userId];
    if (!user) {
      user = {
        userId,
        sessionId: "",
        cwd,
        silent: false,
        crossSessionNotify: "inherit",
        watchedSessions: [],
      };
      this.state.users[userId] = user;
      this.save();
    } else {
      // Backfill missing fields for users created before this feature
      let changed = false;
      if (user.crossSessionNotify !== "on" && user.crossSessionNotify !== "off" && user.crossSessionNotify !== "inherit") {
        user.crossSessionNotify = "inherit";
        changed = true;
      }
      if (!Array.isArray(user.watchedSessions)) {
        user.watchedSessions = user.sessionId ? [user.sessionId] : [];
        changed = true;
      }
      if (changed) this.save();
    }
    return user;
  }

  getUser(userId: string): UserState | undefined {
    return this.state.users[userId];
  }

  update(userId: string, patch: Partial<UserState>): void {
    const user = this.state.users[userId];
    if (!user) return;
    Object.assign(user, patch);
    this.save();
  }

  /** Record that `userId` has been bound to `sessionId` (for cross-session recipient resolution). */
  watchSession(userId: string, sessionId: string): void {
    if (!sessionId) return;
    const user = this.state.users[userId];
    if (!user) return;
    if (!Array.isArray(user.watchedSessions)) user.watchedSessions = [];
    if (!user.watchedSessions.includes(sessionId)) {
      user.watchedSessions.push(sessionId);
      // Cap history to avoid unbounded growth
      if (user.watchedSessions.length > 100) user.watchedSessions = user.watchedSessions.slice(-100);
      this.save();
    }
  }

  /** Effective cross-session preference for display. */
  getNotifyPreference(userId: string): "inherit" | "on" | "off" {
    const user = this.state.users[userId];
    if (!user) return "inherit";
    if (user.crossSessionNotify === "on" || user.crossSessionNotify === "off") return user.crossSessionNotify;
    return "inherit";
  }

  all(): UserState[] {
    return Object.values(this.state.users);
  }
}
