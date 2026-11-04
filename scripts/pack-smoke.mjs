// Clean-install test for the npm package. It installs with --ignore-scripts: SQLite is the built-in
// node:sqlite, so the package must start with no install or build step at all.
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

/** `npm pack --json` is an array up to npm 11 and an object keyed by package name from npm 12. */
const packed = (json) => (Array.isArray(json) ? json[0] : Object.values(json)[0]);

function pack(dest) {
  mkdirSync(dest, { recursive: true }); // npm pack --pack-destination needs the directory to exist
  const dry = packed(JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json"], { cwd: pkgDir, encoding: "utf8" })));
  checkFiles(dry.files.map((f) => f.path));
  const out = packed(JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", dest], { cwd: pkgDir, encoding: "utf8" })));
  const tarball = join(dest, out.filename);
  console.log(`pack-smoke: packed ${tarball} (${out.size} bytes)`);
  return tarball;
}

async function installAndRun(tarball) {
  const app = mkdtempSync(join(tmpdir(), "closeloop-clean-"));
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "clean-install-test", private: true }));
  execFileSync(npm, ["install", resolve(tarball), "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: app, stdio: "inherit" });
  console.log(`pack-smoke: installed into ${app} (no repo, fresh node_modules, --ignore-scripts)`);

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LLM_") && !k.startsWith("CLOSELOOP_")));
  const runEnv = { ...env, HOME: app, USERPROFILE: app, CLOSELOOP_DB: join(app, "state.db") };
  // The synthetic Razorpay recon report, written by the installed package itself (CSV path exercises the CSV parser).
  const report = join(app, "recon.synthetic.csv");
  execFileSync(npx, ["--no-install", "closeloop-mcp", "demo-report", report], { cwd: app, env: runEnv, stdio: ["ignore", "ignore", "inherit"] });
  const child = spawn(npx, ["--no-install", "closeloop-mcp"], { cwd: app, env: runEnv, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  // Only complete (newline-terminated) messages: a large response can arrive split across stdout chunks.
  const lines = () => stdout.split("\n").slice(0, -1).filter((l) => l.trim());
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
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "import_razorpay_recon", arguments: { file_path: report } } });
  const imported = await waitFor(4);
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "run_reconciliation", arguments: { from: "2026-10-01", to: "2026-10-31" } } });
  const run = await waitFor(5);
  child.kill();

  for (const l of lines()) if (JSON.parse(l).jsonrpc !== "2.0") fail(`non-JSON-RPC line on stdout: ${l}`);
  if (tools.result?.tools?.length !== 10) fail(`expected 10 tools, got ${tools.result?.tools?.length}`);
  if (call.result?.isError) fail(`tool call failed: ${call.result.content?.[0]?.text}`);
  if (imported.result?.isError || !(imported.result?.structuredContent?.inserted > 0)) fail(`import_razorpay_recon failed: ${imported.result?.content?.[0]?.text}`);
  if (!(run.result?.structuredContent?.matched?.bank_credits_batch_gateway_report > 0)) fail(`no BATCH_FROM_GATEWAY_REPORT matches after import: ${run.result?.content?.[0]?.text}`);
  console.log(`pack-smoke: ${tools.result.tools.length} tools; decompose_bank_credit → ${call.result.content[0].text.split("\n")[0]}`);
  console.log(`pack-smoke: import_razorpay_recon → ${imported.result.content[0].text.split("\n")[0]}`);
  console.log(`pack-smoke: run_reconciliation with the report → ${run.result.structuredContent.matched.bank_credits_batch_gateway_report} credits matched from the gateway report`);
  console.log("pack-smoke: stderr:\n" + stderr.trim());
  console.log(`pack-smoke: OK on Node ${process.version} (${process.platform}/${process.arch})`);
}

if (args[0] === "--tarball") await installAndRun(args[1]);
else if (args[0] === "--pack-only") pack(resolve(args[1] ?? "."));
else await installAndRun(pack(mkdtempSync(join(tmpdir(), "closeloop-pack-"))));
