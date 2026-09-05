/**
 * session-log.cjs: live-preset reads must not decompress a whole
 * multi-frame zstd log on every `/s list` row. Cache keyed by
 * (path, size, mtime); appends scan only the new tail.
 */

import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";

// `zstdCompressSync` is unstable (Stability 1) and missing in some
// Node 24 builds (CI Ubuntu 24.04 has no sync Zstd API). Build zstd
// frames via the stable stream API (`createZstdCompress`, available
// since Node 22.15) which is shipped alongside the decompressor.
async function zstdCompressBuffer(buf: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const source = Readable.from([buf]);
  const compressor = zlib.createZstdCompress();
  compressor.on("data", (c) => chunks.push(c));
  // Manually drive the pipeline — source → compressor, then end the
  // source to flush. Using `pipeline(source, compressor)` closes the
  // compressor's readable side prematurely; pump + wait works.
  const done = new Promise<void>((res, rej) => {
    compressor.on("end", () => res());
    compressor.on("error", rej);
  });
  source.pipe(compressor);
  source.on("end", () => compressor.end());
  await done;
  return Buffer.concat(chunks);
}

const require = createRequire(import.meta.url);
const log = require("../src/dsh/session-log.cjs") as {
  clearSessionLogCache: () => void;
  projectKey: (cwd: string) => string;
  readSessionRuntimePreset: (cwd: string, sessionId: string, root?: string) => string | undefined;
};

async function writeLog(opts: {
  dshHome: string;
  cwd: string;
  sessionId: string;
  headerAgentPreset?: string;
  formatVersion?: number;
  fileName?: string;
  events?: Array<{ type: string; data?: unknown }>;
}) {
  const {
    dshHome,
    cwd,
    sessionId,
    headerAgentPreset,
    formatVersion = 0,
    fileName = "session.jsonl.zstd",
    events = [],
  } = opts;
  const dir = path.join(dshHome, "sessions", log.projectKey(cwd), encodeURIComponent(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({
    type: "session",
    version: formatVersion,
    id: sessionId,
    createdAt: Date.now(),
    cwd,
    ...(headerAgentPreset ? { agentPreset: headerAgentPreset } : {}),
  });
  const frames = [await zstdCompressBuffer(Buffer.from(header + "\n"))];
  for (const ev of events) {
    frames.push(await zstdCompressBuffer(Buffer.from(JSON.stringify(ev) + "\n")));
  }
  fs.writeFileSync(path.join(dir, fileName), Buffer.concat(frames));
}

async function appendFrame(opts: {
  dshHome: string;
  cwd: string;
  sessionId: string;
  event: { type: string; data?: unknown };
}) {
  const file = path.join(
    opts.dshHome,
    "sessions",
    log.projectKey(opts.cwd),
    encodeURIComponent(opts.sessionId),
    "session.jsonl.zstd",
  );
  const extra = await zstdCompressBuffer(Buffer.from(JSON.stringify(opts.event) + "\n"));
  fs.appendFileSync(file, extra);
}

describe("session-log runtime preset cache", () => {
  let dshHome: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    log.clearSessionLogCache();
    dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-slog-"));
    originalEnv = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;
  });

  afterEach(() => {
    log.clearSessionLogCache();
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalEnv;
  });

  it("returns the newest agent-preset/selected, else the header", async () => {
    const cwd = "C:\\work";
    await writeLog({
      dshHome, cwd, sessionId: "s-1",
      headerAgentPreset: "standard",
      events: [
        { type: "user/message", data: {} },
        { type: "agent-preset/selected", data: { agentPreset: "cordis" } },
      ],
    });
    expect(log.readSessionRuntimePreset(cwd, "s-1", dshHome)).toBe("cordis");
  });

  it("reads the v2 generation and prefers it over an older generation", async () => {
    const cwd = "C:\\work";
    await writeLog({
      dshHome,
      cwd,
      sessionId: "s-v2",
      headerAgentPreset: "legacy",
      formatVersion: 0,
      fileName: "session.jsonl.zstd",
    });
    await writeLog({
      dshHome,
      cwd,
      sessionId: "s-v2",
      headerAgentPreset: "standard",
      formatVersion: 2,
      fileName: "session.v2.jsonl.zstd",
      events: [{ type: "agent-preset/selected", data: { agentPreset: "cordis" } }],
    });
    expect(log.readSessionRuntimePreset(cwd, "s-v2", dshHome)).toBe("cordis");
  });

  it("reads a plaintext v2 generation", async () => {
    const cwd = "C:\\work";
    const sessionId = "s-v2-plain";
    const dir = path.join(dshHome, "sessions", log.projectKey(cwd), encodeURIComponent(sessionId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "session.v2.jsonl"),
      JSON.stringify({
        type: "session",
        version: 2,
        id: sessionId,
        createdAt: Date.now(),
        cwd,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: "standard",
      }) + "\n",
    );
    expect(log.readSessionRuntimePreset(cwd, sessionId, dshHome)).toBe("standard");
  });

  it("finds a v2 log under DSH's escaped session-id directory", async () => {
    const cwd = "C:\\work";
    const sessionId = "s/escaped";
    const dir = path.join(dshHome, "sessions", log.projectKey(cwd), "s~002Fescaped");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "session.v2.jsonl"),
      JSON.stringify({
        type: "session",
        version: 2,
        id: sessionId,
        createdAt: Date.now(),
        cwd,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: "standard",
      }) + "\n",
    );
    expect(log.readSessionRuntimePreset(cwd, sessionId, dshHome)).toBe("standard");
  });

  it("returns the cached preset when size and mtime are unchanged (no re-read)", async () => {
    const cwd = "C:\\work";
    await writeLog({
      dshHome, cwd, sessionId: "s-cache",
      headerAgentPreset: "standard",
      events: [
        { type: "agent-preset/selected", data: { agentPreset: "cordis" } },
        { type: "user/message", data: {} },
        { type: "user/message", data: {} },
      ],
    });
    expect(log.readSessionRuntimePreset(cwd, "s-cache", dshHome)).toBe("cordis");
    // Spy on fs.readFileSync — it is configurable under ESM, unlike
    // zstdDecompressSync on the node:zlib namespace. The cache hit
    // path must not call it.
    const readSpy = vi.spyOn(fs, "readFileSync");
    expect(log.readSessionRuntimePreset(cwd, "s-cache", dshHome)).toBe("cordis");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("only scans the appended tail after the first read", async () => {
    const cwd = "C:\\work";
    await writeLog({
      dshHome, cwd, sessionId: "s-tail",
      headerAgentPreset: "standard",
      events: [
        { type: "agent-preset/selected", data: { agentPreset: "cordis" } },
        { type: "user/message", data: {} },
        { type: "user/message", data: {} },
        { type: "user/message", data: {} },
      ],
    });
    expect(log.readSessionRuntimePreset(cwd, "s-tail", dshHome)).toBe("cordis");
    await appendFrame({
      dshHome, cwd, sessionId: "s-tail",
      event: { type: "user/message", data: { n: 1 } },
    });
    // After the append, the cache is stale (size grew); a partial read
    // is allowed (the new tail only). Spy on readFileSync — the
    // incremental path reads just the new suffix, not the full file.
    const readSpy = vi.spyOn(fs, "readFileSync");
    expect(log.readSessionRuntimePreset(cwd, "s-tail", dshHome)).toBe("cordis");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("picks up a newer agent-preset/selected written after the cached scan", async () => {
    const cwd = "C:\\work";
    await writeLog({
      dshHome, cwd, sessionId: "s-flip",
      headerAgentPreset: "standard",
      events: [{ type: "agent-preset/selected", data: { agentPreset: "cordis" } }],
    });
    expect(log.readSessionRuntimePreset(cwd, "s-flip", dshHome)).toBe("cordis");
    await appendFrame({
      dshHome, cwd, sessionId: "s-flip",
      event: { type: "agent-preset/selected", data: { agentPreset: "minimal" } },
    });
    expect(log.readSessionRuntimePreset(cwd, "s-flip", dshHome)).toBe("minimal");
  });
});
