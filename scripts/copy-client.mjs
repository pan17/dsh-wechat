// Copy the authored client bundle (module-loader format) into dist/.
// The client is plain JS authored directly in the DSH client module format,
// so no bundling is required — only a copy.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, "dist"), { recursive: true });
copyFileSync(join(root, "src", "client.js"), join(root, "dist", "client.js"));
console.log("client bundle copied → dist/client.js");
// session-log.cjs is loaded at runtime via `import("./session-log.cjs")`
// from dist/dsh/ops.js. tsc does not copy .cjs (include is ts/mjs only).
mkdirSync(join(root, "dist", "dsh"), { recursive: true });
copyFileSync(
  join(root, "src", "dsh", "session-log.cjs"),
  join(root, "dist", "dsh", "session-log.cjs"),
);
console.log("session-log helper copied → dist/dsh/session-log.cjs");
