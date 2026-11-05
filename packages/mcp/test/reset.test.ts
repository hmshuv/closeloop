import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/dev.js", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "closeloop-reset-"));
const state = join(home, ".closeloop", "closeloop.db");
// A clean environment: default DB under this HOME, no LLM, no Razorpay keys, no repo .env (cwd is HOME).
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LLM_") && !k.startsWith("CLOSELOOP_"))), HOME: home, USERPROFILE: home };

type Result = { status?: string; match_kind?: string | null; resolved?: { bank_line_id: string }[] };

/** One stdio session, as Claude Desktop runs it: initialize, then the given tool calls in order. */
async function session(calls: [string, Record<string, unknown>][]): Promise<{ results: Result[]; stderr: string }> {
  const child = spawn(process.execPath, [bin], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const reply = async (id: number) => {
    for (let i = 0; i < 600; i++) {
      const line = stdout.split("\n").slice(0, -1).find((l) => l.includes(`"id":${id},`) || l.includes(`"id":${id}}`));
      if (line) return JSON.parse(line) as { result?: { structuredContent?: Result; isError?: boolean; content?: { text: string }[] } };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no reply to ${id}\n${stderr}`);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "reset-test", version: "0" } } });
  await reply(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const results: Result[] = [];
  for (const [i, [name, args]] of calls.entries()) {
    send({ jsonrpc: "2.0", id: i + 2, method: "tools/call", params: { name, arguments: args } });
    const r = await reply(i + 2);
    if (r.result?.isError) throw new Error(`${name}: ${r.result.content?.[0]?.text}`);
    results.push(r.result?.structuredContent ?? {});
  }
  child.kill();
  await new Promise((r) => child.once("exit", r));
  return { results, stderr };
}

const cli = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: home, env, encoding: "utf8" });

describe("closeloop-mcp reset", () => {
  it("removes imported recon data with the rest of the demo state, so bnk_000236 is a MATCH_CONFLICT again", async () => {
    const report = join(home, "recon.synthetic.json");
    expect(cli("demo-report", report).status).toBe(0);

    const first = await session([
      ["decompose_bank_credit", { bank_line_id: "bnk_000236" }],
      ["import_razorpay_recon", { file_path: report }],
      ["decompose_bank_credit", { bank_line_id: "bnk_000236" }],
    ]);
    expect(first.results[0]).toMatchObject({ status: "conflict" });
    expect(first.results[2]).toMatchObject({ match_kind: "BATCH_FROM_GATEWAY_REPORT" });
    // Startup names the resolved state paths.
    expect(first.stderr).toContain(`state db   ${state} (default; set CLOSELOOP_DB to change)`);
    expect(first.stderr).toMatch(/gateway report {2}none imported: amount-only/);

    // The report persists across restarts until reset.
    const again = await session([["decompose_bank_credit", { bank_line_id: "bnk_000236" }]]);
    expect(again.results[0]).toMatchObject({ match_kind: "BATCH_FROM_GATEWAY_REPORT" });
    expect(again.stderr).toMatch(/gateway report {2}4864 imported recon rows/);

    const reset = cli("reset");
    expect(reset.status).toBe(0);
    expect(reset.stderr).toContain(`removed:\n  ${state} (`);
    expect(reset.stderr).toContain(join(home, ".closeloop", "truth.db"));
    expect(existsSync(state)).toBe(false);

    const after = await session([["decompose_bank_credit", { bank_line_id: "bnk_000236" }]]);
    expect(after.results[0]).toMatchObject({ status: "conflict", match_kind: null });
    expect(after.stderr).toMatch(/seeding demo data/);
    expect(after.stderr).toMatch(/gateway report {2}none imported: amount-only/);

    expect(cli("reset").stderr).toContain("removed:"); // the re-seeded state
    expect(cli("reset").stderr).toContain("nothing to remove");
  }, 120_000);

  it("refuses to reset when real data is attached via CLOSELOOP_SOURCE_DB", () => {
    const r = spawnSync(process.execPath, [bin, "reset"], { cwd: home, env: { ...env, CLOSELOOP_SOURCE_DB: join(home, "source.db") }, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/reset is for the demo/);
  });
});
