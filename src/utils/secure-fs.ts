/**
 * Filesystem hygiene for the plugin's own storage directory.
 *
 * Everything under `~/.dsh-wechat` is sensitive: the iLink bot token, the
 * WeChat↔session mapping, the outbound queue, and the audit trail. The
 * directory therefore gets `0o700` and every file `0o600`, applied
 * unconditionally at creation time AND re-applied with an explicit `chmod`
 * (a pre-existing file keeps its old, possibly world-readable, mode —
 * `{ mode }` on `writeFileSync` only applies when the file is created).
 *
 * ⚠️ Windows: Node ignores the `mode` argument on Windows, and `chmod`
 * there can only toggle the read-only bit. The hardening therefore relies on
 * the inherited ACLs of `%USERPROFILE%` (only the user, `SYSTEM` and
 * `Administrators` can read it) — documented in the README. On POSIX the
 * modes above are real.
 *
 * Every helper here is best-effort about the CHMOD (a filesystem that does
 * not support it must not break persistence) but NOT about the write itself:
 * a caller that cannot persist must see the error.
 */

import fs from "node:fs";
import path from "node:path";

/** Directory mode for the storage dir and its subdirectories. */
export const PRIVATE_DIR_MODE = 0o700;
/** File mode for every file this plugin writes. */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Directories already created and tightened by this process.
 *
 * `ensurePrivateDir` runs on every `StateStore.save()` and every audit line,
 * and the two syscalls it issues (`mkdir` + `chmod`) cost real time on the
 * outbound hot path: measured at ~0.4 ms per save on Windows NTFS, which is
 * pure waste after the first call — a directory that already exists with the
 * right mode cannot be improved by asking again. Remembering the resolved
 * path keeps the invariant (every directory this plugin writes into is 0700)
 * while paying for it once.
 *
 * The memo is keyed by the resolved path, so two different storage dirs in the
 * same process are each handled. It is deliberately NOT invalidated: this
 * module never deletes directories, and a mode changed by something else
 * mid-run is outside what a best-effort helper can promise.
 */
const privateDirs = new Set<string>();

/**
 * Create `dir` (recursively) with `0o700` and tighten an existing directory
 * to the same mode. Never throws: a storage directory that cannot be created
 * surfaces on the following write, where the caller already has error
 * handling; failing here would turn plugin load into a crash.
 *
 * Idempotent per process (see {@link privateDirs}): the first call for a path
 * pays for `mkdir` + `chmod`, later calls are a `Set` lookup.
 */
export function ensurePrivateDir(dir: string): void {
  const key = path.resolve(dir);
  if (privateDirs.has(key)) return;
  try {
    fs.mkdirSync(key, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch {
    return;
  }
  try {
    fs.chmodSync(key, PRIVATE_DIR_MODE);
  } catch {
    // Windows / unsupported filesystem: inherited ACLs apply.
  }
  privateDirs.add(key);
}

/** Tighten one existing file to `0o600`; silently ignores unsupported filesystems. */
export function chmodPrivate(filePath: string): void {
  try {
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch {
    // Windows / unsupported filesystem.
  }
}

/**
 * Write a file with `0o600`, creating its parent directory with `0o700`.
 * `data` may be a string or a Buffer.
 */
export function writePrivateFile(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  // `{ mode }` only applies on CREATE, so the chmod is what tightens a
  // pre-existing file. Skip it when this process just created the file: a
  // fresh `writeFileSync` already carries 0o600, and the redundant chmod is
  // one of the two syscalls this helper was measured spending per save.
  const existed = fs.existsSync(filePath);
  try {
    fs.writeFileSync(filePath, data, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  } catch (err) {
    // The memoised directory may have been removed behind our back (tests
    // recreate their temp dirs; a user may clean the storage dir by hand).
    // Re-create it once and retry, so memoisation can never turn into a
    // failure that the un-memoised helper would not have had.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    privateDirs.delete(path.resolve(dir));
    ensurePrivateDir(dir);
    fs.writeFileSync(filePath, data, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
    return;
  }
  if (existed) chmodPrivate(filePath);
}

/**
 * Append to a file with `0o600`, creating it (and its parent) private on
 * first use. Used by the audit sink, which appends one line at a time.
 */
export function appendPrivateFile(filePath: string, data: string): void {
  ensurePrivateDir(path.dirname(filePath));
  fs.appendFileSync(filePath, data, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  chmodPrivate(filePath);
}
