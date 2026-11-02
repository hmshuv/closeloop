import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RECON_SCHEMA, TRUTH_SCHEMA } from "./schema.ts";

export type Db = Database.Database;

function open(path: string, schema: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  return db;
}

/** The reconciliation database: financial source tables (+ recon/audit tables in later phases). */
export function openReconDb(path: string): Db {
  return open(path, RECON_SCHEMA);
}

/** Ground-truth database. Only the generator and the evaluator open this. */
export function openTruthDb(path: string): Db {
  return open(path, TRUTH_SCHEMA);
}

export function defaultDbPath(): string {
  return process.env.CLOSELOOP_DB || join(homedir(), ".closeloop", "closeloop.db");
}

/** truth.db sits next to the recon DB. */
export function truthDbPathFor(reconDbPath: string): string {
  return join(dirname(reconDbPath), "truth.db");
}
