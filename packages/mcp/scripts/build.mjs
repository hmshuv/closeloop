// Bundles the server and @closeloop/core into one ESM file for npm. Native and protocol dependencies stay
// external and are installed normally (better-sqlite3 ships prebuilt binaries for Node 20/22).
import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
rmSync(here("../dist"), { recursive: true, force: true });
rmSync(here("../config"), { recursive: true, force: true });

await build({
  entryPoints: [here("../src/bin.ts")],
  outfile: here("../dist/closeloop-mcp.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["better-sqlite3", "@modelcontextprotocol/sdk", "zod"],
  // Bundled CommonJS code may call require(); give the ESM bundle one.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
});

// Ship the default configuration (JSON only) next to the bundle.
mkdirSync(here("../config"), { recursive: true });
for (const f of readdirSync(here("../../../config"))) if (f.endsWith(".json")) cpSync(here(`../../../config/${f}`), here(`../config/${f}`));
copyFileSync(here("../../../LICENSE"), here("../LICENSE"));
console.error("built dist/closeloop-mcp.js");
