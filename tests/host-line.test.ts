/**
 * Host-line declaration gate — `engines.dsh` and the `@deepseek-ai/dsh` peer.
 *
 * Two DIFFERENT mechanisms declare the host requirement, and they are not
 * interchangeable:
 *
 *   1. `engines.dsh` is DECLARATIVE. `evaluatePluginCompatibility`
 *      (packages/boot/app-boot/src/plugin-compatibility.ts) returns early
 *      unless the manifest declares `peerDependencies`, and no host code reads
 *      `engines` at all. The reader that matters is `dshmarket`, which reads
 *      `engines.dsh` (top-level wins over `dsh.engines.dsh`) and evaluates it
 *      with `{ includePrerelease: true }`.
 *   2. `peerDependencies["@deepseek-ai/dsh"]` is ENFORCED. A mismatch makes the
 *      host SKIP the whole `dsh-wechat` bundle layer (profile.ts catches the
 *      throw into `skippedBundles`), so the bridge silently disappears.
 *
 * The declaration drifted wrong three times before:
 *
 *   1. `>=0.1.5-rc.1` alone — a floor with no ceiling, which admits `1.0.0`.
 *   2. `>=0.1.5-rc.1 || >=0.1.7-0 <0.2.0` — described in an earlier changelog
 *      entry, but this value never actually existed in `package.json`; the real
 *      predecessor was `>=0.2.0-rc.2`.
 *   3. `>=0.2.0-rc.2` alone — the real predecessor. Correct floor, but no
 *      ceiling, so it admitted `0.3.0` and `1.0.0`.
 *
 * The range is now ONE arm, `>=0.2.1-0 <0.3.0-0`, used verbatim in both
 * fields. Per-tuple enumeration (as an earlier revision used) is unnecessary:
 * the only consumer evaluates with `includePrerelease: true`, where a single
 * arm already admits every 0.2.x prerelease — and enumeration could never be
 * complete anyway, since each new 0.2.x tuple would need another arm.
 */

import { describe, expect, it } from "vitest";
import semver from "semver";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as {
  engines?: { dsh?: string };
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const RANGE = manifest.engines?.dsh ?? "";
const PEER = manifest.peerDependencies?.["@deepseek-ai/dsh"] ?? "";

/** Versions the declaration must admit, under plain AND includePrerelease. */
const MUST_ADMIT = [
  "0.2.1-0",
  "0.2.1-rc.2",
  "0.2.1",
  "0.2.2",
  "0.2.3",
  "0.2.99",
];

/** Versions it must reject, under plain AND includePrerelease. */
const MUST_REJECT = [
  // Below the floor: the 0.1.x line was deliberately dropped in v0.9.7.
  "0.1.2-rc.1",
  "0.1.4",
  "0.1.5-rc.1",
  "0.1.9",
  // Below the floor: 0.2.0 and its rc line are no longer claimed.
  "0.2.0-rc.1",
  "0.2.0-rc.2",
  "0.2.0",
  // The unbounded predecessor admitted all of these; the ceiling must not.
  "0.3.0-0",
  "0.3.0-rc.1",
  "0.3.0",
  "1.0.0",
];

describe("engines.dsh declares the host lines this plugin actually runs on", () => {
  it("is a syntactically valid semver range", () => {
    expect(RANGE).not.toBe("");
    expect(semver.validRange(RANGE)).not.toBeNull();
  });

  it.each(MUST_ADMIT)("admits %s under both semver semantics", (version) => {
    expect(semver.satisfies(version, RANGE), `plain: ${version}`).toBe(true);
    expect(
      semver.satisfies(version, RANGE, { includePrerelease: true }),
      `includePrerelease: ${version}`,
    ).toBe(true);
  });

  it.each(MUST_REJECT)("rejects %s under both semver semantics", (version) => {
    expect(semver.satisfies(version, RANGE), `plain: ${version}`).toBe(false);
    expect(
      semver.satisfies(version, RANGE, { includePrerelease: true }),
      `includePrerelease: ${version}`,
    ).toBe(false);
  });

  it("covers the 0.2.1-0 floor and the rc.2 target", () => {
    // The explicit requirement: at least 0.2.1-0, including 0.2.1-rc.2.
    expect(semver.satisfies("0.2.1-0", RANGE, { includePrerelease: true })).toBe(true);
    expect(semver.satisfies("0.2.1-rc.2", RANGE, { includePrerelease: true })).toBe(true);
    expect(semver.satisfies("0.2.1-rc.2", RANGE)).toBe(true);
  });

  it("admits every 0.2.x prerelease under the consumer's semantics", () => {
    // `dshmarket` is the only reader of `engines.dsh`, and it always passes
    // `{ includePrerelease: true }` (lib/discovery-compatibility.js). A single
    // arm is therefore sufficient; no per-tuple enumeration is needed.
    for (const version of ["0.2.1-alpha.1", "0.2.1-rc.1", "0.2.1-rc.2", "0.2.2-rc.1", "0.2.3-rc.1"]) {
      expect(
        semver.satisfies(version, RANGE, { includePrerelease: true }),
        version,
      ).toBe(true);
    }
  });

  it("keeps the 0.3.0 line out even when prereleases are included", () => {
    // `<0.3.0` alone would admit `0.3.0-rc.1` under includePrerelease; the
    // `-0` fence post is what closes that hole.
    expect(semver.satisfies("0.3.0-rc.1", ">=0.2.1-0 <0.3.0", { includePrerelease: true })).toBe(
      true,
    );
    expect(
      semver.satisfies("0.3.0-rc.1", ">=0.2.1-0 <0.3.0-0", { includePrerelease: true }),
    ).toBe(false);
  });
});

describe("@deepseek-ai/dsh peer turns the declarative claim into an enforced one", () => {
  it("declares the peer with exactly the same range as engines.dsh", () => {
    // One value, two fields: no chance of the two drifting apart.
    expect(PEER).not.toBe("");
    expect(semver.validRange(PEER)).not.toBeNull();
    expect(PEER).toBe(RANGE);
  });

  it("admits the running host runtime (0.2.1-rc.2)", () => {
    // The host evaluates peers with `{ includePrerelease: true }`
    // (`semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`).
    expect(semver.satisfies("0.2.1-rc.2", PEER, { includePrerelease: true })).toBe(true);
  });

  it("is marked optional so installing it does not pull in the whole harness", () => {
    // Measured with `pnpm pack` + tarball install (closest to the registry
    // path): WITHOUT this flag the install FAILS (`exit=1`) — the peer is
    // resolved as a real dependency, `@deepseek-ai/dsh` is a meta package with
    // 82 dependencies, and the tree runs into a 404 for the unpublished
    // `@deepseek-ai/dsh-type-meta`. Even when it resolves, the lockfile grows
    // from 28 lines to 8199. The host gate does NOT read
    // `peerDependenciesMeta`, so marking it optional removes the install-time
    // cost while keeping enforcement intact.
    expect(manifest.peerDependenciesMeta?.["@deepseek-ai/dsh"]?.optional).toBe(true);
  });

  it("declares exactly one peer: the meta package, not the leaf packages", () => {
    // `@anysearch/anysearch-dsh` instead declares several LEAF host packages
    // (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-web`, …) with `"*"`, trading
    // version protection for "a new host release needs no manifest edit".
    // This repo pins the single meta package instead.
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(["@deepseek-ai/dsh"]);
  });

  it("still enforces the range despite being optional", () => {
    // Guard against the assumption that `optional: true` exempts the plugin:
    // `evaluatePluginCompatibility` only reads `peerDependencies`, so a wrong
    // range is rejected (and the bundle skipped) either way.
    expect(semver.satisfies("99.0.0", PEER, { includePrerelease: true })).toBe(false);
    expect(semver.satisfies("0.3.0", PEER, { includePrerelease: true })).toBe(false);
  });
});

describe("PUBLISH.md documents the declaration that actually ships", () => {
  const publishDoc = readFileSync(
    fileURLToPath(new URL("../PUBLISH.md", import.meta.url)),
    "utf8",
  );

  it("quotes the live range, so the release checklist cannot go stale", () => {
    // The checklist tells maintainers to update BOTH fields; the snippet it
    // shows must be the one in package.json, or the doc becomes the next
    // source of a wrong declaration (the predecessor of this file recommended
    // an exact `=x.y.z` pin, which is how the missing ceiling started).
    expect(publishDoc).toContain(`"dsh": "${RANGE}"`);
    expect(publishDoc).toContain(`"@deepseek-ai/dsh": "${PEER}"`);
  });

  it("keeps telling maintainers that the peer must stay optional", () => {
    expect(publishDoc).toContain("peerDependenciesMeta");
    expect(publishDoc).toMatch(/optional/);
  });

  it("warns that the ceiling needs the -0 fence post", () => {
    expect(publishDoc).toContain("<0.3.0-0");
  });
});
