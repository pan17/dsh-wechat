#!/usr/bin/env node
/**
 * One-command release prep: bump the version, archive the CHANGELOG section,
 * commit and tag. Pushing is opt-in (`--push`) because PUBLISH.md requires a
 * human confirmation before anything leaves the machine.
 *
 *   npm run release 0.13.4 --dry-run
 *   npm run release 0.13.4
 *   npm run release 0.13.4 --push
 *   npm run release patch|minor|major        # semver keyword
 *
 * Why a script: the manual sequence (edit package.json → remember that
 * package-lock.json carries the version twice → move the CHANGELOG entries
 * under a dated heading → commit → tag → push both) has four steps that fail
 * silently. A forgotten lockfile edit makes `npm ci` re-resolve; a forgotten
 * CHANGELOG move makes the GitHub Release ship empty notes; a tag that
 * disagrees with package.json now fails the release workflow, but only after
 * a full build+test cycle. Every one of those is checked here, before a
 * single commit exists.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgPath = path.join(root, "package.json");
const changelogPath = path.join(root, "CHANGELOG.md");

// On Windows `npm` is a `.cmd` shim that `execFileSync` cannot spawn directly
// (ENOENT — it does not consult PATHEXT like a shell does). Running the shim
// through `cmd.exe` avoids `shell: true`, which Node deprecates for args
// arrays (DEP0190: args are concatenated, not escaped). `git` is a real .exe.
const IS_WIN = process.platform === "win32";
const NPM = IS_WIN ? "npm.cmd" : "npm";

/** Run a command, returning trimmed stdout. Throws with stderr on failure. */
function run(cmd, args, opts = {}) {
  const [file, argv] = IS_WIN && cmd === NPM
    ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", NPM, ...args]]
    : [cmd, args];
  try {
    const out = execFileSync(file, argv, {
      cwd: opts.cwd ?? root,
      encoding: "utf8",
      // `inherit` yields no captured stdout, so callers that stream to the
      // terminal get null back rather than an empty string.
      stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    });
    return out === null ? "" : out.trim();
  } catch (error) {
    const detail = String(error.stderr ?? "").trim() || String(error.message ?? error);
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${detail}`);
  }
}

function tryRun(cmd, args, opts = {}) {
  try {
    return run(cmd, args, opts);
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function info(message) {
  console.log(`  ${message}`);
}

// ── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
const positional = argv.filter((arg) => !arg.startsWith("--"));

// `npm run release patch --dry-run` (no `--` separator) never reaches us as an
// argument: npm claims `--dry-run` as its own config and drops it. Running
// that command used to perform a REAL release. npm still exports the config as
// `npm_config_dry_run`, so honour it — the flag then means "dry run" however
// it was spelled. Both `npm run release -- patch --dry-run` (recommended) and
// the bare form now stop before touching a file.
// `npm run release patch --push` (no `--`) has the same trap and no argument
// to recover from — but npm exports every `--flag` as `npm_config_<flag>`,
// so `--push` arrives here as `npm_config_push=true`. Honour it as well, which
// makes both spellings work instead of silently not pushing.
const npmFlag = (name) => String(process.env[`npm_config_${name}`] ?? "").toLowerCase() === "true";
const dryRun = flags.has("--dry-run") || npmFlag("dry_run");
const push = flags.has("--push") || npmFlag("push");

for (const flag of flags) {
  if (!["--dry-run", "--push"].includes(flag)) fail(`未知参数 ${flag}（可用：--dry-run、--push）`);
}
if (positional.length !== 1) {
  fail("用法：npm run release -- <版本|patch|minor|major> [--dry-run] [--push]");
}
const target = positional[0];

// ── Preflight ───────────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(current)) fail(`package.json 的版本 ${current} 不是 x.y.z 形式`);

/** Resolve `patch` / `minor` / `major` against the current version. */
function resolveVersion(spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const m = /^(patch|minor|major)$/.exec(spec);
  if (!m) fail(`版本必须是 x.y.z 或 patch/minor/major，收到 ${spec}`);
  const [major, minor, patch] = current.split(".").map(Number);
  if (spec === "major") return `${major + 1}.0.0`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const version = resolveVersion(target);
const tag = `v${version}`;

if (version === current) fail(`版本已经是 ${current}，没有要发布的内容`);

// A release commit must be the ONLY change in its commit, or the tag stops
// being a meaningful pointer at "the tree we released".
const dirty = run("git", ["status", "--porcelain"]);
if (dirty) fail(`工作区有未提交的改动，先提交或 stash：\n${dirty}`);

const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") fail(`当前分支是 ${branch}，发布只能在 main 上进行`);

if (tryRun("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]) !== null) {
  fail(`本地已存在 tag ${tag}`);
}
// Empty output means the tag is absent on the remote; null means the check
// itself failed (offline), which is not a reason to block a release.
const remoteTags = tryRun("git", ["ls-remote", "--tags", "origin", tag]);
if (remoteTags) fail(`远端已存在 tag ${tag}`);

// npm 上已存在同一版本时 publish 会 403 失败，且 Release 已经指向旧内容——
// 此时唯一正确的做法是换版本号，而不是重打 tag。
const published = tryRun(NPM, ["view", `dsh-wechat@${version}`, "version"]);
if (published) fail(`npm 上已存在 dsh-wechat@${version}，请换一个版本号`);

// ── CHANGELOG rewrite ───────────────────────────────────────────────────────

const changelog = readFileSync(changelogPath, "utf8");
// `\r?\n` rather than `\r?$`: in multiline mode `$` sits BEFORE the `\n`, so
// `\r?$` swallows the CR and leaves the LF to start the remainder — which then
// produced a stray blank line under the new heading.
const unreleasedRe = /^## \[Unreleased\]\r?\n/m;
const unreleasedMatch = unreleasedRe.exec(changelog);
if (!unreleasedMatch) fail("CHANGELOG.md 里找不到 `## [Unreleased]`");

// The repo's CHANGELOG is CRLF on Windows and LF on CI; mixing the two would
// make every release commit touch every line of the file.
const eol = changelog.includes("\r\n") ? "\r\n" : "\n";

// The entries between `## [Unreleased]` and the next `## [` heading are what
// this release ships. An empty section produces an empty GitHub Release.
const afterUnreleased = changelog.slice(unreleasedMatch.index + unreleasedMatch[0].length);
const nextHeading = /^## \[/m.exec(afterUnreleased);
const sectionBody = nextHeading ? afterUnreleased.slice(0, nextHeading.index) : afterUnreleased;
if (!/^\s*-\s+\S/m.test(sectionBody)) {
  fail("CHANGELOG.md 的 [Unreleased] 下没有任何条目，GitHub Release 会没有内容");
}

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
const heading = `## [${version}] - ${today}`;
// Keep `## [Unreleased]` as an empty section, then the dated heading, then the
// entries that just moved under it, then whatever followed (older versions).
const trimmedBody = sectionBody.replace(/^\s+/, "").replace(/\s+$/, "");
const nextChangelog =
  changelog.slice(0, unreleasedMatch.index + unreleasedMatch[0].length) +
  eol +
  heading +
  eol + eol +
  trimmedBody.replace(/\r?\n/g, eol) +
  eol + eol +
  (nextHeading ? afterUnreleased.slice(nextHeading.index).replace(/\r?\n/g, eol) : "");

// ── Dry run ─────────────────────────────────────────────────────────────────

if (dryRun) {
  console.log(`\n[dry-run] ${current} → ${version}（tag ${tag}）`);
  info("package.json 与 package-lock.json 的 version 会一起改成 " + version);
  info("CHANGELOG 会插入以下标题，并把现有条目归入它：");
  console.log("\n" + heading + "\n");
  info("将执行：git commit -m \"release: " + tag + "\" && git tag " + tag);
  info(push ? "并推送：git push origin main --tags" : "不推送（需要时加 --push）");
  console.log("");
  process.exit(0);
}

// ── Apply ───────────────────────────────────────────────────────────────────

console.log(`\n发布 ${current} → ${version}（tag ${tag}）\n`);

// `npm version` rewrites BOTH package.json and package-lock.json (the version
// appears twice in the lockfile). Editing package.json by hand is how the two
// drift apart.
run(NPM, ["version", version, "--no-git-tag-version", "--allow-same-version"]);
info(`package.json / package-lock.json → ${version}`);

writeFileSync(changelogPath, nextChangelog, "utf8");
info(`CHANGELOG.md → ${heading}`);

run("git", ["add", "-A"]);
run("git", ["commit", "-m", `release: ${tag}`]);
info(`commit: release: ${tag}`);

run("git", ["tag", tag]);
info(`tag: ${tag}`);

if (push) {
  try {
    run("git", ["push", "origin", "main", "--tags"], { stdio: ["ignore", "inherit", "inherit"] });
  } catch (error) {
    // The commit and tag are already local and correct — only the push
    // failed. Say so instead of dumping a stack trace: retrying is just
    // `git push`, not re-running this script (which would be refused).
    console.error(`\n✗ 推送失败：\n${String(error.message ?? error)}\n`);
    console.error("版本号、CHANGELOG、commit 与 tag 都已在本地完成。修好网络或权限后直接执行：\n");
    console.error(`  git push origin main --tags\n`);
    process.exit(1);
  }
  info("已推送 main 与 tag，Release 工作流会自动开始");
} else {
  console.log("\n下一步（确认无误后执行）：\n");
  console.log(`  git push origin main --tags\n`);
  console.log("版本号与 CHANGELOG 已经改完并提交，所以不要重跑本命令（会被拦下）。\n");
}
