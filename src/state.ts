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

/** One globally ordered outbound queue for the bridge's single WeChat peer. */
export type OutboundMessage =
  | { kind: "text"; text: string }
  | { kind: "file"; filePath: string; fileName: string };

export const MAX_OUTBOUND_QUEUE = 100;

export interface OutboundState {
  version: 1;
  peerUserId: string;
  messageCount: number;
  queue: OutboundMessage[];
}

export interface BridgeStateFile {
  users: Record<string, UserState>;
  /** Single-peer send-window state; absent in legacy files and when empty. */
  outbound?: OutboundState;
}

function normalizeOutbound(value: unknown): OutboundState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { version?: unknown; peerUserId?: unknown; messageCount?: unknown; queue?: unknown };
  if (raw.version !== 1 || typeof raw.peerUserId !== "string" || !raw.peerUserId) return undefined;

  const count = typeof raw.messageCount === "number" && Number.isFinite(raw.messageCount)
    ? Math.max(0, Math.min(10, Math.floor(raw.messageCount)))
    : 0;
  const queue: OutboundMessage[] = [];
  if (Array.isArray(raw.queue)) {
    for (const item of raw.queue) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as Record<string, unknown>;
      if (candidate.kind === "text" && typeof candidate.text === "string") {
        queue.push({ kind: "text", text: candidate.text });
      } else if (
        candidate.kind === "file" &&
        typeof candidate.filePath === "string" && candidate.filePath &&
        typeof candidate.fileName === "string" && candidate.fileName
      ) {
        queue.push({ kind: "file", filePath: candidate.filePath, fileName: candidate.fileName });
      }
    }
  }

  return {
    version: 1,
    peerUserId: raw.peerUserId,
    messageCount: count,
    queue: queue.slice(-MAX_OUTBOUND_QUEUE),
  };
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
          const outbound = normalizeOutbound(parsed.outbound);
          if (outbound) parsed.outbound = outbound;
          else delete parsed.outbound;
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
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), "utf-8");
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // best effort cleanup
      }
      throw err;
    }
  }

  ensureUser(userId: string, cwd: string, opts?: { silent?: boolean }): UserState {
    let user = this.state.users[userId];
    if (!user) {
      user = {
        userId,
        sessionId: "",
        cwd,
        silent: opts?.silent === true,
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

  /** Return a defensive copy of the single-peer outbound snapshot. */
  outbound(): OutboundState | undefined {
    const value = this.state.outbound;
    if (!value) return undefined;
    return { ...value, queue: value.queue.map((item) => ({ ...item })) };
  }

  /** Replace and durably save the single-peer outbound snapshot. */
  setOutbound(value: OutboundState): void {
    const normalized = normalizeOutbound(value);
    if (!normalized) throw new Error("invalid outbound state");
    this.state.outbound = normalized;
    this.save();
  }

  /** Remove any durable outbound budget and queue. */
  clearOutbound(): void {
    if (!this.state.outbound) return;
    delete this.state.outbound;
    this.save();
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

  /**
   * Drop every persisted WeChat user. Logout / re-login must not keep the
   * previous single-user peer, or a newly scanned account is ignored.
   */
  clearUsers(): void {
    if (Object.keys(this.state.users).length === 0) return;
    this.state.users = {};
    this.save();
  }
}
