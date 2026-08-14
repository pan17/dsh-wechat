/**
 * Durable per-user bridge state: session mapping, silent mode, workspace
 * and agent-preset choices.
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
  /** Agent preset selected via /agent switch (applied to new sessions). */
  agentPreset?: string;
  /** Silent mode: only send the final text of each turn. */
  silent: boolean;
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
        if (parsed && typeof parsed === "object" && parsed.users) return parsed;
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
      };
      this.state.users[userId] = user;
      this.save();
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

  all(): UserState[] {
    return Object.values(this.state.users);
  }
}
