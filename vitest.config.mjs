import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // Reclaims the temp dirs the suite creates with `mkdtempSync`, which
    // creates but never deletes. Without this each run orphans ~360 dirs.
    globalSetup: ["./tests/temp-cleanup.setup.ts"],
    // Vitest v4 on Ubuntu CI can tear the worker RPC down while a
    // console.log is still in flight (EnvironmentTeardownError:
    // Closing rpc while "onUserConsoleLog" was pending). All tests
    // already passed; the leftover rejection fails the job anyway.
    // See vitest-dev/vitest#9458 / podman-desktop#17285.
    onUnhandledError(error) {
      const message = String(error?.message ?? error);
      if (
        error?.name === "EnvironmentTeardownError" &&
        message.includes('Closing rpc while "onUserConsoleLog" was pending')
      ) {
        return false;
      }
    },
  },
});
