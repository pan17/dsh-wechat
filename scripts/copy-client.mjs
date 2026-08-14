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
