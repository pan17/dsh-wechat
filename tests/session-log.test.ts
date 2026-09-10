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
  locateSessionLog: (cwd: string, sessionId: string, root?: string) => string | undefined;
  parseGenerationLogFilename: (filename: string) => number | undefined;
  projectKey: (cwd: string) => string;
  readSessionRuntimePreset: (cwd: string, sessionId: string, root?: string) => string | undefined;
  readSessionRecency: (cwd: string, sessionId: string, root?: string) => number | undefined;
  readSessionListFacts: (
    cwd: string,
    sessionId: string,
    root?: string,
  ) => { preset?: string; title?: string; lastUserMessageTime?: number };
  readSessionUsedHint: (
    cwd: string,
    sessionId: string,
    root?: string,
  ) => { status: "used"; time?: number } | { status: "blank" } | { status: "unknown" };
};

async function writeLog(opts: {
  dshHome: string;
  cwd: string;
  sessionId: string;
  headerAgentPreset?: string;
  events?: Array<{ type: string; data?: unknown; time?: number }>;
  filename?: string;
  version?: number;
}) {
  const { dshHome, cwd, sessionId, headerAgentPreset, events = [], filename = "session.jsonl.zstd", version = 0 } = opts;
  const dir = path.join(dshHome, "sessions", log.projectKey(cwd), encodeURIComponent(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({
    type: "session",
    version,
    id: sessionId,
    createdAt: Date.now(),
    cwd,
    ...(headerAgentPreset ? { agentPreset: headerAgentPreset } : {}),
  });
  const frames = [await zstdCompressBuffer(Buffer.from(header + "\n"))];
  for (const ev of events) {
    frames.push(await zstdCompressBuffer(Buffer.from(JSON.stringify(ev) + "\n")));
  }
  fs.writeFileSync(path.join(dir, filename), Buffer.concat(frames));
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

  it("readSessionRecency finds the last user/message without readFileSync", async () => {
    const cwd = "C:\\work";
    await writeLog({
      dshHome, cwd, sessionId: "s-recency",
      headerAgentPreset: "standard",
      events: [
        { type: "user/message", data: {}, time: 10 },
        { type: "assistant/message", data: {}, time: 11 },
        { type: "user/message", data: {}, time: 99 },
        { type: "assistant/message", data: {}, time: 100 },
      ],
    });
    const readSpy = vi.spyOn(fs, "readFileSync");
    expect(log.readSessionRecency(cwd, "s-recency", dshHome)).toBe(99);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("readSessionListFacts returns title, live preset, and recency together", async () => {
    const cwd = "C:\\work";
    await writeLog({
      dshHome, cwd, sessionId: "s-facts",
      headerAgentPreset: "standard",
      events: [
        { type: "user/message", data: {}, time: 5 },
        { type: "session/title", data: { title: "修列表速度", messageSeqs: [], source: { kind: "fallback" } } },
        { type: "agent-preset/selected", data: { agentPreset: "cordis" } },
        { type: "user/message", data: {}, time: 50 },
      ],
    });
    expect(log.readSessionListFacts(cwd, "s-facts", dshHome)).toEqual({
      preset: "cordis",
      title: "修列表速度",
      lastUserMessageTime: 50,
    });
  });

  it("readSessionUsedHint reports a header-only log as blank", async () => {
    const cwd = "C:\\work";
    await writeLog({
      dshHome, cwd, sessionId: "s-blank",
      headerAgentPreset: "standard",
    });
    expect(log.readSessionUsedHint(cwd, "s-blank", dshHome)).toEqual({ status: "blank" });
  });

  it("readSessionUsedHint treats a large artifact as used without readFileSync", async () => {
    const cwd = "C:\\work";
    await writeLog({
      dshHome, cwd, sessionId: "s-fat",
      headerAgentPreset: "standard",
    });
    const file = path.join(
      dshHome,
      "sessions",
      log.projectKey(cwd),
      encodeURIComponent("s-fat"),
      "session.jsonl.zstd",
    );
    fs.appendFileSync(file, Buffer.alloc(2048, 1));
    const readSpy = vi.spyOn(fs, "readFileSync");
    expect(log.readSessionUsedHint(cwd, "s-fat", dshHome)).toEqual({ status: "used" });
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

describe("session-log generation filenames (DSH 0.1.5 V3)", () => {
  it("parseGenerationLogFilename accepts canonical names only", () => {
    expect(log.parseGenerationLogFilename("session.jsonl")).toBe(0);
    expect(log.parseGenerationLogFilename("session.jsonl.zstd")).toBe(0);
    expect(log.parseGenerationLogFilename("session.v2.jsonl.zstd")).toBe(2);
    expect(log.parseGenerationLogFilename("session.v3.jsonl")).toBe(3);
    expect(log.parseGenerationLogFilename("session.v0.jsonl.zstd")).toBeUndefined();
    expect(log.parseGenerationLogFilename("session.v03.jsonl.zstd")).toBeUndefined();
    expect(log.parseGenerationLogFilename("session.tmp.jsonl.zstd")).toBeUndefined();
  });

  let dshHome: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    log.clearSessionLogCache();
    dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-slog-v3-"));
    originalEnv = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;
  });

  afterEach(() => {
    log.clearSessionLogCache();
    if (originalEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalEnv;
  });

  it("reads a v3 artifact when that is the only generation", async () => {
    const cwd = "C:\\work";
    await writeLog({
      dshHome, cwd, sessionId: "s-v3",
      headerAgentPreset: "cordis",
      filename: "session.v3.jsonl.zstd",
      version: 3,
      events: [{ type: "user/message", data: { source: { kind: "user" } }, time: 77 }],
    });
    expect(log.locateSessionLog(cwd, "s-v3", dshHome)?.endsWith("session.v3.jsonl.zstd")).toBe(true);
    expect(log.readSessionListFacts(cwd, "s-v3", dshHome)).toEqual({
      preset: "cordis",
      title: undefined,
      lastUserMessageTime: 77,
    });
  });

  it("prefers the highest generation when v0 and v3 coexist after migration", async () => {
    const cwd = "C:\\work";
    await writeLog({
      dshHome, cwd, sessionId: "s-mig",
      headerAgentPreset: "standard",
      filename: "session.jsonl.zstd",
      version: 0,
      events: [{ type: "user/message", data: {}, time: 1 }],
    });
    await writeLog({
      dshHome, cwd, sessionId: "s-mig",
      headerAgentPreset: "cordis",
      filename: "session.v3.jsonl.zstd",
      version: 3,
      events: [
        { type: "user/message", data: {}, time: 99 },
        { type: "session/title", data: { title: "迁移后的会话" } },
      ],
    });
    expect(path.basename(log.locateSessionLog(cwd, "s-mig", dshHome)!)).toBe("session.v3.jsonl.zstd");
    expect(log.readSessionListFacts(cwd, "s-mig", dshHome)).toEqual({
      preset: "cordis",
      title: "迁移后的会话",
      lastUserMessageTime: 99,
    });
  });
});
