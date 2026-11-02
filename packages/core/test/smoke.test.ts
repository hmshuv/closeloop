import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CLOSELOOP_VERSION } from "../src/index.ts";

describe("toolchain smoke test", () => {
  it("loads the core package", () => {
    expect(CLOSELOOP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("opens an in-memory SQLite database via the native binding", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (paise INTEGER NOT NULL)");
    db.prepare("INSERT INTO t (paise) VALUES (?)").run(123_456);
    const row = db.prepare("SELECT paise FROM t").get() as { paise: number };
    expect(row.paise).toBe(123_456);
    db.close();
  });

  it("validates with zod", () => {
    const Paise = z.number().int().safe();
    expect(Paise.safeParse(100).success).toBe(true);
    expect(Paise.safeParse(1.5).success).toBe(false);
  });
});
