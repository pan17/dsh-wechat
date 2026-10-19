/**
 * Append-only audit trail for the bridge's security-relevant events.
 *
 * One JSON object per line in `<storageDir>/audit.jsonl`. What is recorded
 * is deliberately shallow: WHO (a masked WeChat id), WHAT happened, and the
 * SIZE of a payload — never the message body, never a token, never a full
 * file content. The trail exists so an operator can answer "was a stranger
 * turned away?", "who raised the global permission default?", "which file did
 * the agent push to WeChat?" after the fact, without turning the log itself
 * into a second copy of the conversation.
 *
 * Bounded by construction: the file is capped at {@link AUDIT_MAX_BYTES} and
 * rotated to a single `<name>.1` predecessor, so the sink can never grow
 * without limit — the same rule the outbound queue follows ("a memory bound
 * must be enforced by code that removes memory on every path; retry is never
 * the bound"). Every rotation is logged loudly.
 *
 * Failure policy: auditing is best-effort and MUST NOT break the message
 * path — a read-only storage directory would otherwise turn every send into a
 * failure. The first failure is reported through the injected logger, then
 * further failures are counted and reported only on the way back up (so a
 * permanently broken sink does not flood the console).
 *
 * ## Why this holds an open descriptor instead of calling appendFileSync
 *
 * `record()` sits on the OUTBOUND hot path — `deliverOutboundLocked` writes
 * one line per send attempt, including the ones that only end up queued. The
 * obvious implementation (`ensurePrivateDir` + `appendFileSync` + `chmod`
 * + `stat` on every call) costs four synchronous syscalls per line: on Windows
 * NTFS that measured at ~0.9 ms per line, which turned a 450-attempt test into
 * 19.6 s and blew the 5 s default timeout. Nothing about that cost is
 * necessary:
 *
 *   - the directory is created and tightened ONCE, on first use (the mode of
 *     an existing file is already settled — re-chmod'ing it on every append
 *     cannot improve it, only cost a syscall);
 *   - the descriptor stays open across appends, so there is no per-line
 *     open/close;
 *   - the size is tracked in memory (`bytes`), so there is no per-line `stat`.
 *
 * The same measurement with a held descriptor: ~10.5 ms for those 450 lines.
 *
 * Correctness rules that keep the cheap path honest:
 *   - `bytes` is SEEDED from `fstat` when the descriptor opens, so a file left
 *     behind by a previous process is counted, not assumed empty;
 *   - every write failure drops the descriptor (`closeFd`), so the next call
 *     re-opens and re-seeds instead of writing into a stale handle;
 *   - rotation closes the descriptor before the rename and lets the next
 *     append re-open the fresh file — a rotated-away fd would keep appending
 *     to `<name>.1`.
 */

import fs from "node:fs";
import path from "node:path";
import { chmodPrivate, ensurePrivateDir, PRIVATE_FILE_MODE } from "./secure-fs.js";

/** Cap of one audit file before it is rotated. Keep the previous file too. */
export const AUDIT_MAX_BYTES = 1 << 20; // 1 MiB
/** Longest single JSONL line kept — a runaway value must not eat the cap alone. */
export const AUDIT_MAX_LINE_CHARS = 2000;

export class AuditLog {
  private readonly filePath: string;
  private readonly previousPath: string;
  /** Known on-disk size of the live file; -1 until the descriptor is opened. */
  private bytes = -1;
  /** Open append descriptor, or null when not (yet) opened. */
  private fd: number | null = null;
  private failures = 0;

  constructor(
    private readonly storageDir: string,
    private readonly log: (message: string) => void,
    /** Injectable for tests; defaults to the module constant. */
    private readonly maxBytes: number = AUDIT_MAX_BYTES,
  ) {
    this.filePath = path.join(storageDir, "audit.jsonl");
    this.previousPath = `${this.filePath}.1`;
  }

  /** Absolute path of the live audit file (reported on failure by the caller's log line). */
  path(): string {
    return this.filePath;
  }

  /**
   * Append one event. Adds `time` (ISO-8601) to the record; the caller owns
   * every other field and must already have masked identifiers and dropped
   * bodies.
   */
  record(event: Record<string, unknown>): void {
    let line: string;
    try {
      line = `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`;
    } catch {
      // A circular / non-serializable value must not break the caller.
      this.fail("serialize");
      return;
    }
    if (line.length > AUDIT_MAX_LINE_CHARS) {
      line = `${line.slice(0, AUDIT_MAX_LINE_CHARS - 2)}"}\n`;
    }
    try {
      let fd = this.ensureOpen();
      if (this.bytes + Buffer.byteLength(line) > this.maxBytes) {
        this.rotate();
        // `rotate()` closed the descriptor; re-open against the fresh file.
        fd = this.ensureOpen();
      }
      this.writeAll(fd, line);
      this.bytes += Buffer.byteLength(line);
      if (this.failures > 0) {
        this.log(`audit sink recovered after ${this.failures} failure(s)`);
        this.failures = 0;
      }
    } catch (err) {
      this.closeFd();
      this.fail(`append: ${String(err)}`);
    }
  }

  /**
   * Open (once) the live audit file with `0o600`, creating the storage dir
   * `0o700` on first use, and seed {@link bytes} from the real file size.
   *
   * The `chmod` here is the one that matters: `{ mode }` on `open` only applies
   * when the file is CREATED, so a pre-existing world-readable `audit.jsonl`
   * would otherwise keep its old mode forever.
   */
  private ensureOpen(): number {
    if (this.fd !== null) return this.fd;
    ensurePrivateDir(this.storageDir);
    const fd = fs.openSync(this.filePath, "a", PRIVATE_FILE_MODE);
    try {
      chmodPrivate(this.filePath);
      this.bytes = fs.fstatSync(fd).size;
    } catch (err) {
      // Do not leak the descriptor on a failed open handshake.
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing left to do; the caller reports the original error.
      }
      throw err;
    }
    this.fd = fd;
    return fd;
  }

  /** Write the whole buffer, tolerating a short write. */
  private writeAll(fd: number, line: string): void {
    const buffer = Buffer.from(line, "utf-8");
    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    }
  }

  /** Close the descriptor, if any, so the next call re-opens and re-seeds. */
  private closeFd(): void {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      // A descriptor that cannot be closed is gone as far as we can tell.
    }
    this.fd = null;
  }

  /**
   * Release the descriptor. Called from `WeChatDSHBridge.stop()` so a plugin
   * dispose does not leave an open handle behind (a re-`apply()` in the same
   * process must not accumulate them). Auditing continues to work afterwards:
   * the next `record()` simply re-opens.
   */
  close(): void {
    this.closeFd();
  }

  /**
   * Rename the live file to `<name>.1`, replacing any previous rotation, and
   * start a new one. Logged loudly: an audit trail that silently loses its
   * history is worse than no trail at all.
   */
  private rotate(): void {
    // Close FIRST: an open descriptor follows the inode, so writing after the
    // rename would append to `<name>.1` instead of the new live file.
    this.closeFd();
    try {
      fs.renameSync(this.filePath, this.previousPath);
      chmodPrivate(this.previousPath);
    } catch (err) {
      // Rename failed (e.g. the file vanished): truncate instead so the cap
      // still holds.
      this.log(`audit rotation failed, truncating instead: ${String(err)}`);
      try {
        fs.truncateSync(this.filePath, 0);
      } catch {
        // The append below will report whatever is really wrong.
      }
    }
    this.log(`audit log reached ${this.maxBytes} bytes; rotated to ${path.basename(this.previousPath)}`);
    // The next `ensureOpen()` re-seeds this from the new file's real size.
    this.bytes = 0;
  }

  private fail(what: string): void {
    this.failures += 1;
    if (this.failures === 1) {
      this.log(`audit ${what} failed; auditing is degraded (further failures are counted, not logged)`);
    }
  }
}
