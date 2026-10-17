/**
 * Reclaims the temp directories the suite creates with `fs.mkdtempSync`.
 *
 * `mkdtempSync` creates but never deletes, so a single `npm test` used to leave
 * ~360 orphaned directories behind in the OS temp folder; repeated local runs
 * piled up tens of thousands of them (21294 by 2026-10-17). Rather than depend
 * on each of the 47 test files remembering a `finally { fs.rmSync(...) }`, this
 * teardown sweeps once for the whole suite.
 *
 * Only entries that both (a) match a test-owned prefix and (b) did not exist
 * before the run are removed. Directories owned by the DSH host itself
 * (`dsh-spill-*`, `dsh-subprocess-*`, `dsh-workspace-changes-*`, `dsh-acl-*`,
 * `dsh-mcp-probe-cwd`, ...) match no prefix here and are never touched, so a
 * concurrently running host session cannot be damaged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Prefixes the suite passes to `mkdtempSync`, or uses for temp files. */
const TEST_TEMP_PREFIXES = [
  "dsh-wx-",
  "dsh-home-",
  "dsh-wechat-",
  "wx-process-",
  "send-wechat-",
];

const isTestTempEntry = (name: string): boolean =>
  TEST_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));

/** Names of test-owned temp entries currently present in `root`. */
const testEntries = (root: string): Set<string> => {
  try {
    return new Set(fs.readdirSync(root).filter(isTestTempEntry));
  } catch {
    return new Set();
  }
};

/** `null` until `setup` runs, so a skipped setup can never trigger a sweep. */
let preexisting: Set<string> | null = null;

export async function setup(): Promise<void> {
  preexisting = testEntries(os.tmpdir());
}

export async function teardown(): Promise<void> {
  if (preexisting === null) return; // setup did not run: sweep nothing
  const root = os.tmpdir();
  const known = preexisting;
  preexisting = null;

  let removed = 0;
  for (const name of testEntries(root)) {
    if (known.has(name)) continue; // outlived the previous run: not ours
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // A worker may still hold a handle on Windows; not fatal.
    }
  }
  if (removed > 0) {
    console.log(`[temp-cleanup] removed ${removed} leftover test temp ${removed === 1 ? "entry" : "entries"}`);
  }
}
