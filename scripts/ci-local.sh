#!/usr/bin/env bash
# Run exactly what CI runs, on a Linux filesystem, without touching you
# Windows/macOS working copy's node_modules.
#
# Why this exists: CI is `ubuntu-latest`. A test that asserts on a path built by
# `path.resolve` / `path.join` from a Windows-shaped literal (e.g. `C:\home\.dsh`)
# passes locally on Windows and fails on Linux, because on POSIX that literal is
# a RELATIVE path and resolves under the cwd — so `built.startsWith("C:\home\.dsh/sessions")`
# is never true. That exact assertion shipped in a PR, was green locally, and went
# red on the first Linux run. Run this before opening a PR that touches tests.
#
# Usage (Linux, macOS, or Windows via WSL):
#   bash scripts/ci-local.sh
#
# On Windows the working copy lives on a DrvFs mount (`/mnt/c/...` or `/mnt/d/...`),
# where npm's platform-specific devDependencies (esbuild / rollup) would be
# installed for the wrong OS. So the script copies the checkout into $TMPDIR first
# and installs there, leaving your working copy untouched.

set -euo pipefail

# Guard against the failure mode this script exists to prevent, in its own
# environment: under WSL, Windows binaries are reachable on PATH through
# interop, so an unqualified `node` can be the WINDOWS node. That runs `tsc`
# from a UNC working directory (fails with "CMD.EXE does not support UNC
# paths") and, worse, would have exercised win32 path semantics while claiming
# to test Linux — the exact false green this script is meant to eliminate.
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH. CI pins Node 22; install it and put it first on PATH." >&2
  exit 2
fi
node_bin="$(command -v node)"
case "$node_bin" in
  /mnt/[a-z]/*)
    echo "ERROR: the 'node' on PATH is a WINDOWS binary ($node_bin) reached through WSL interop." >&2
    echo "That tests the wrong platform — POSIX path semantics are what CI exercises." >&2
    echo "Put a Linux node first on PATH, e.g.:  export PATH=\"\$HOME/node22/bin:\$PATH\"" >&2
    exit 2
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/dsh-wechat-ci-XXXXXX")"
trap 'rm -rf "$work"' EXIT

echo "=== source: $root"
echo "=== workdir: $work (a Linux-native filesystem; your checkout is not touched)"
echo "=== node: $(node -v) at $node_bin"

# Copy without the heavy/generated dirs; .git is not needed to build or test.
( cd "$root" && tar -cf - --exclude=.git --exclude=node_modules --exclude=dist . ) | ( cd "$work" && tar -xf - )

cd "$work"
echo "=== npm ci"
npm ci --no-audit --no-fund
echo "=== tsc --noEmit"
npx tsc --noEmit
echo "=== vitest run"
npx vitest run

echo
echo "All CI steps passed on $(uname -s)."
