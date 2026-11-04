/**
 * Teardown probe: what is still keeping the host process alive?
 *
 * The DSH desktop treats a plugin dispose as the end of its graceful window —
 * after the disposer resolves the host only sets `process.exitCode` and waits
 * for the event loop to drain, and SIGTERMs the process 10 s later. A single
 * ref'd handle left behind is therefore enough to fail an in-app update, and
 * "which handle" is invisible from the outside.
 *
 * This module dumps the live libuv handles at three points (plugin start,
 * dispose entry, dispose exit) into `<storageDir>/teardown.log`. For a
 * `Timeout` it prints the idle duration, which names the culprit directly
 * (10 s keepalive / 30 s dedupe / 35 s long poll / 120 s typing fallback).
 *
 * Cost when idle: three small appends per process lifetime. Bounded: the file
 * is truncated once it passes {@link MAX_BYTES}, so a long-lived install with
 * many restarts cannot grow it without limit.
 */

import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 256 * 1024;

/** Opt-in: one line per boot is noise for a healthy install, gold for a report. */
const TEARDOWN_DEBUG = process.env.DSH_WECHAT_TEARDOWN_DEBUG === "1";

interface HandleLike {
  constructor?: { name?: string };
  _idleTimeout?: number;
  _repeat?: number | null;
  _onTimeout?: unknown;
  localAddress?: string;
  localPort?: number;
  remoteAddress?: string;
  remotePort?: number;
  destroyed?: boolean;
  pending?: boolean;
  listening?: boolean;
  hasRef?: () => boolean;
  ref?: () => unknown;
}

function refState(handle: HandleLike): string {
  try {
    return typeof handle.hasRef === "function" ? `ref=${String(handle.hasRef())}` : "ref=?";
  } catch {
    return "ref=?";
  }
}

/** One line per handle, naming the kind and the facts that identify it. */
function describe(handle: HandleLike): string {
  const kind = handle.constructor?.name ?? "Unknown";
  const parts: string[] = [kind, refState(handle)];
  if (handle._idleTimeout !== undefined) {
    // A Timeout is the usual suspect: the duration names its owner.
    parts.push(`idleTimeout=${handle._idleTimeout}ms`);
    if (handle._repeat) parts.push(`repeat=${handle._repeat}ms`);
  }
  if (handle.localPort !== undefined || handle.remotePort !== undefined) {
    parts.push(`local=${handle.localAddress ?? "?"}:${handle.localPort ?? "?"}`);
    parts.push(`remote=${handle.remoteAddress ?? "?"}:${handle.remotePort ?? "?"}`);
  }
  if (handle.destroyed !== undefined) parts.push(`destroyed=${String(handle.destroyed)}`);
  if (handle.pending !== undefined) parts.push(`pending=${String(handle.pending)}`);
  if (handle.listening !== undefined) parts.push(`listening=${String(handle.listening)}`);
  return parts.join(" ");
}

/** Count every active resource by name, e.g. `{Timeout: 2, TCPSocketWrap: 1}`. */
function countResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1;
  } catch {
    counts.unavailable = 1;
  }
  return counts;
}

function appendBounded(file: string, text: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.truncateSync(file, 0);
    } catch {
      // No file yet — the append below creates it.
    }
    fs.appendFileSync(file, text, { mode: 0o600 });
  } catch {
    // Diagnostics must never break dispose.
  }
}

/**
 * Append one snapshot. `detail` is a short free-form line for plugin state
 * (monitor running, typing count, …) that a bare handle dump cannot show.
 *
 * Off by default: set `DSH_WECHAT_TEARDOWN_DEBUG=1` to enable it. A single
 * quit then names the exact handle that refused to go away, which is the one
 * fact an outside observer cannot get from a host that was SIGTERM'd.
 */
export function probeTeardown(
  storageDir: string,
  label: string,
  detail?: Record<string, unknown>,
): void {
  if (!TEARDOWN_DEBUG) return;
  try {
    const lines: string[] = [`${new Date().toISOString()} [${label}] pid=${process.pid}`];
    if (detail) lines.push(`  state: ${JSON.stringify(detail)}`);
    lines.push(`  resources: ${JSON.stringify(countResources())}`);
    const handles = ((process as unknown as { _getActiveHandles?: () => unknown[] })
      ._getActiveHandles?.() ?? []) as HandleLike[];
    for (const handle of handles) lines.push(`  handle ${describe(handle)}`);
    const requests = ((process as unknown as { _getActiveRequests?: () => unknown[] })
      ._getActiveRequests?.() ?? []) as HandleLike[];
    for (const request of requests) lines.push(`  request ${describe(request)}`);
    appendBounded(path.join(storageDir, "teardown.log"), `${lines.join("\n")}\n`);
  } catch {
    // Never break dispose.
  }
}
