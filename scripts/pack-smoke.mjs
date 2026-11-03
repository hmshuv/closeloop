// Clean-install test for the npm package (better-sqlite3 is native, so this must work from scratch).
//   node scripts/pack-smoke.mjs                  pack packages/mcp, then install + run it in an empty temp dir
//   node scripts/pack-smoke.mjs --pack-only DIR  only pack (after the file-list check) into DIR
//   node scripts/pack-smoke.mjs --tarball FILE   only install + run an existing tarball
// Requires `pnpm build` first when packing.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("../packages/mcp/", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const args = process.argv.slice(2);
const fail = (msg) => {
  console.error(`pack-smoke: FAIL: ${msg}`);
  process.exit(1);
};

/** Only these may ship. Secrets (.env), databases (*.db), ~/.closeloop and sources must never be packed. */
const ALLOWED = [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^dist\/closeloop-mcp\.js$/, /^config\/[a-z]+\.json$/];
const FORBIDDEN = [/\.env/, /\.db($|-)/, /\.closeloop/, /truth/, /(^|\/)src\//, /\.ts$/];

function checkFiles(files) {
  for (const f of files) {
    if (FORBIDDEN.some((re) => re.test(f))) fail(`forbidden file in package: ${f}`);
    if (!ALLOWED.some((re) => re.test(f))) fail(`unexpected file in package: ${f}`);
  }
  if (!files.includes("dist/closeloop-mcp.js")) fail("dist/closeloop-mcp.js missing; run `pnpm build` first");
  console.log(`pack-smoke: package contents OK (${files.length} files): ${files.join(", ")}`);
}

function pack(dest) {
  mkdirSync(dest, { recursive: true }); // npm pack --pack-destination needs the directory to exist
  const dry = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json"], { cwd: pkgDir, encoding: "utf8" }));
  checkFiles(dry[0].files.map((f) => f.path));
  const out = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", dest], { cwd: pkgDir, encoding: "utf8" }));
  const tarball = join(dest, out[0].filename);
  console.log(`pack-smoke: packed ${tarball} (${out[0].size} bytes)`);
  return tarball;
}

async function installAndRun(tarball) {
  const app = mkdtempSync(join(tmpdir(), "closeloop-clean-"));
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "clean-install-test", private: true }));
  execFileSync(npm, ["install", resolve(tarball), "--no-audit", "--no-fund", "--loglevel=error"], { cwd: app, stdio: "inherit" });
  console.log(`pack-smoke: installed into ${app} (no repo, fresh node_modules)`);

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LLM_") && !k.startsWith("CLOSELOOP_")));
  const child = spawn(npx, ["--no-install", "closeloop-mcp"], { cwd: app, env: { ...env, HOME: app, USERPROFILE: app, CLOSELOOP_DB: join(app, "state.db") }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const lines = () => stdout.split("\n").filter((l) => l.trim());
  const response = (id) => lines().map((l) => JSON.parse(l)).find((m) => m.id === id);
  const waitFor = async (id) => {
    for (let i = 0; i < 600; i++) {
      const r = response(id);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    fail(`no response to request ${id}\nstderr:\n${stderr}`);
  };

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pack-smoke", version: "0" } } });
  await waitFor(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "decompose_bank_credit", arguments: { bank_line_id: "bnk_000080" } } });
  const tools = await waitFor(2);
  const call = await waitFor(3);
  child.kill();

  for (const l of lines()) if (JSON.parse(l).jsonrpc !== "2.0") fail(`non-JSON-RPC line on stdout: ${l}`);
  if (tools.result?.tools?.length !== 9) fail(`expected 9 tools, got ${tools.result?.tools?.length}`);
  if (call.result?.isError) fail(`tool call failed: ${call.result.content?.[0]?.text}`);
  console.log(`pack-smoke: ${tools.result.tools.length} tools; decompose_bank_credit → ${call.result.content[0].text.split("\n")[0]}`);
  console.log("pack-smoke: stderr:\n" + stderr.trim());
  console.log(`pack-smoke: OK on Node ${process.version} (${process.platform}/${process.arch})`);
}

if (args[0] === "--tarball") await installAndRun(args[1]);
else if (args[0] === "--pack-only") pack(resolve(args[1] ?? "."));
else await installAndRun(pack(mkdtempSync(join(tmpdir(), "closeloop-pack-"))));
