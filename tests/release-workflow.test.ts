/**
 * Release pipeline guard.
 *
 * The release flow has one property that matters above all others: **a
 * failure must not produce a half-published release.** GitHub Release and
 * npm must move together, and a tag that disagrees with `package.json` must
 * fail before either exists.
 *
 * These assertions are static (they read the workflow files) because the
 * alternative — running GitHub Actions — is not available in a unit test.
 * That is the same trade-off `tests/host-line.test.ts` makes for PUBLISH.md:
 * the doc/workflow is the artefact, so pin the artefact.
 *
 * History this pins down:
 *
 *   - `publish-npm` used to declare `needs: ci-green` while the comment above
 *     it claimed it waited on `release`. A Release that failed (missing
 *     CHANGELOG section, API hiccup) still let npm publish, so the two
 *     artefacts could drift apart.
 *   - `ci-green` polled `ci.yml` for 5 minutes. `ci.yml` only triggers on
 *     `push: branches: [main]`, so a tag pushed alone had no run to wait for
 *     (guaranteed timeout), and pushing `main` + tag together started the
 *     poll and the CI run simultaneously — one slow run (7m35s) blew the
 *     budget and blocked the release until someone re-ran it by hand.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const release = read(".github/workflows/release.yml");
const ci = read(".github/workflows/ci.yml");
const publishDoc = read("PUBLISH.md");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

/** The `jobs:` block of a workflow, split into one string per job. */
function jobBlocks(yaml: string): Record<string, string> {
  const jobs: Record<string, string> = {};
  const start = yaml.search(/^jobs:/m);
  if (start === -1) return jobs;
  const body = yaml.slice(start);
  // A job starts at a 2-space-indented key; its body runs until the next one.
  const re = /^ {2}([A-Za-z0-9_-]+):\s*$/gm;
  const marks: Array<{ name: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) marks.push({ name: match[1]!, index: match.index });
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.index : body.length;
    jobs[mark.name] = body.slice(mark.index, end);
  });
  return jobs;
}

const releaseJobs = jobBlocks(release);
const ciJobs = jobBlocks(ci);

/**
 * Strip YAML comment lines before asserting on content.
 *
 * The workflows carry long explanatory comments — including the ones that
 * document the very bugs these tests guard (e.g. a comment saying "no
 * separate `npm run build`"). Matching against raw text would make those
 * comments trip their own assertions.
 */
const code = (yaml: string) =>
  yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

describe("release workflow: verification happens in place", () => {
  it("is triggered by tags only", () => {
    // `branches:` here would fire the publisher on every main push.
    expect(release).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:/);
    expect(release).not.toMatch(/^\s{4}branches:/m);
  });

  it("does not poll another workflow", () => {
    // The whole point of the rewrite: nothing to wait for.
    expect(code(release)).not.toContain("ci-green");
    expect(code(release)).not.toMatch(/seq 1 60/);
    expect(code(release)).not.toContain("actions/runs?head_sha");
  });

  it("builds and tests the tagged commit itself", () => {
    const verify = releaseJobs.verify;
    expect(verify).toBeDefined();
    expect(verify).toContain("npm ci");
    expect(verify).toContain("npm run build");
    expect(verify).toContain("npm test");
  });

  it("refuses a tag that disagrees with package.json", () => {
    // Checked in `verify`, i.e. before a Release or an npm version exists —
    // so the mistake costs nothing to undo.
    const verify = releaseJobs.verify!;
    expect(verify).toContain("package.json");
    expect(verify).toContain("GITHUB_REF_NAME");
  });
});

describe("release workflow: npm and the GitHub Release cannot drift", () => {
  it("publish-npm waits on release, not on the verifier", () => {
    // The bug this guards: `needs: ci-green` let npm publish even when the
    // Release job had failed.
    expect(releaseJobs["publish-npm"]).toBeDefined();
    expect(releaseJobs["publish-npm"]).toMatch(/needs:\s*release\b/);
  });

  it("release waits on verify", () => {
    expect(releaseJobs.release).toBeDefined();
    expect(releaseJobs.release).toMatch(/needs:\s*verify\b/);
  });

  it("publishes with the documented secret", () => {
    expect(releaseJobs["publish-npm"]).toContain("NODE_AUTH_TOKEN: ${{ secrets.DSH_WECHAT }}");
    expect(publishDoc).toContain("DSH_WECHAT");
  });

  it("serialises releases and never cancels one midway", () => {
    expect(release).toMatch(/concurrency:/);
    expect(release).toContain("cancel-in-progress: false");
  });
});

describe("release workflow: npm cache survives a version bump", () => {
  it.each([
    ["ci.yml", () => ciJobs.build!],
    ["release.yml verify", () => releaseJobs.verify!],
    ["release.yml publish-npm", () => releaseJobs["publish-npm"]!],
  ])("%s restores the cache with a prefix fallback", (_name, block) => {
    // `npm version` rewrites package-lock.json on every release, so a cache
    // keyed strictly on hashFiles(lockfile) ALWAYS missed on the release
    // commit (one cold install took 7m01s). `restore-keys` turns a key change
    // into a partial hit.
    const body = block();
    expect(body).toContain("actions/cache@v4");
    expect(body).toContain("restore-keys:");
    expect(body).toContain("hashFiles('package-lock.json')");
  });

  it("does not use setup-node's strict cache mode", () => {
    // `cache: npm` is the option that has no fallback.
    expect(release).not.toMatch(/^\s*cache:\s*npm\s*$/m);
    expect(ci).not.toMatch(/^\s*cache:\s*npm\s*$/m);
  });
});

describe("release workflow: the published tarball is the tested one", () => {
  it("does not build twice", () => {
    // `prepublishOnly` already runs `npm run build && npm test`. A separate
    // `npm run build` in the workflow tested the pre-hook output.
    expect(pkg.scripts.prepublishOnly).toContain("npm run build");
    expect(pkg.scripts.prepublishOnly).toContain("npm test");
    expect(code(releaseJobs["publish-npm"]!)).not.toContain("npm run build");
  });

  it("runs npm publish exactly once", () => {
    expect(code(release).match(/npm publish/g)?.length).toBe(1);
  });
});

describe("release workflow: bounded jobs", () => {
  it("every job has a timeout", () => {
    // Without a timeout a hung `npm ci` occupies a runner for the default
    // 6 hours and blocks the concurrency group with it.
    for (const [name, block] of Object.entries(releaseJobs)) {
      expect(block, `${name} has no timeout-minutes`).toContain("timeout-minutes:");
    }
    for (const [name, block] of Object.entries(ciJobs)) {
      expect(block, `${name} has no timeout-minutes`).toContain("timeout-minutes:");
    }
  });
});

describe("release script", () => {
  it("is wired to npm run release", () => {
    expect(pkg.scripts.release).toBe("node scripts/release.mjs");
  });

  it("keeps push opt-in", () => {
    // PUBLISH.md requires a human confirmation before anything leaves the
    // machine, so the default path must stop after the tag.
    const script = read("scripts/release.mjs");
    expect(script).toContain('"--push"');
    expect(script).toMatch(/if \(push\)/);
  });

  it("survives npm swallowing --dry-run and --push", () => {
    // `npm run release patch --dry-run` never delivers the flag to the
    // script: npm claims it as its own config. Before this fallback existed,
    // that command performed a REAL release (version bump, commit, tag).
    // npm exports each flag as `npm_config_<name>`, which is the recovery
    // path — both spellings must therefore be honoured.
    const script = read("scripts/release.mjs");
    expect(script).toContain("npm_config_dry_run");
    expect(script).toContain("npm_config_push");
    expect(script).toMatch(/npmFlag\("dry_run"\)/);
    expect(script).toMatch(/npmFlag\("push"\)/);
  });

  it("tells maintainers to use the -- separator", () => {
    // The documented command must be the safe one, not merely a working one.
    // The unsafe spelling may still appear inside the warning that explains
    // it — but never as a bare instruction line in a shell block.
    expect(publishDoc).toContain("npm run release -- patch --dry-run");
    expect(publishDoc).toContain("npm run release -- patch --push");
    const commandLines = publishDoc
      .split("\n")
      .filter((line) => /^npm run release/.test(line.trim()));
    expect(commandLines.length).toBeGreaterThan(0);
    for (const line of commandLines) {
      expect(line, `missing "--": ${line}`).toMatch(/npm run release -- /);
    }
  });

  it("explains why the separator is required", () => {
    expect(publishDoc).toMatch(/`--` 不能省/);
  });

  it("refuses an empty [Unreleased] section", () => {
    // An empty section means empty GitHub Release notes, which the
    // changelog query would otherwise accept silently.
    const script = read("scripts/release.mjs");
    expect(script).toContain("Unreleased");
    expect(script).toContain("没有任何条目");
  });

  it("keeps both version fields in sync via npm version", () => {
    // package-lock.json carries the version twice; editing package.json by
    // hand is how the two drift apart.
    const script = read("scripts/release.mjs");
    expect(script).toContain("--no-git-tag-version");
    expect(script).toContain("--allow-same-version");
  });
});

describe("PUBLISH.md describes the pipeline that exists", () => {
  it("names the one-command release path", () => {
    expect(publishDoc).toContain("npm run release");
  });

  it("no longer tells maintainers to wait for CI after pushing a tag", () => {
    // The old instructions described a flow that could not work for a
    // standalone tag push. Mentioning `ci-green` in the "why this changed"
    // note is fine; presenting it as a pipeline step is not.
    expect(publishDoc).not.toMatch(/推 tag 后[^\n]*等 ?CI/);
    expect(publishDoc).not.toMatch(/^\s*\d+\.\s+\*\*`ci-green`\*\*/m);
  });

  it("documents the verify → release → publish-npm chain", () => {
    expect(publishDoc).toMatch(/verify → release → publish-npm/);
    // The drift guard must be stated where maintainers will read it.
    expect(publishDoc).toMatch(/`publish-npm` 等的是 `release`/);
  });
});
