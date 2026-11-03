import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FINANCIAL_TABLES, RECON_SCHEMA, STATE_SCHEMA, TRUTH_SCHEMA } from "./schema.ts";

export type Db = Database.Database;

function open(path: string, schema: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  return db;
}

export interface OpenReconOptions {
  /**
   * Customer deployments: a separate SQLite file holding the financial source tables, attached read-only.
   * The state DB at `path` then holds only engine output (runs, exceptions, audit). Unqualified table names
   * resolve to the attached source because the state DB has no financial tables of its own. If the file is
   * on a read-only mount, SQLite opens it read-only and any write fails at the storage layer. The source
   * must use rollback-journal mode (not WAL) to be readable from a read-only mount.
   */
  sourcePath?: string;
}

/** The reconciliation database: financial source tables plus engine state, or state + an attached read-only source. */
export function openReconDb(path: string, opts: OpenReconOptions = {}): Db {
  if (!opts.sourcePath) return open(path, RECON_SCHEMA);
  if (!existsSync(opts.sourcePath)) throw new Error(`Source database not found: ${opts.sourcePath}`);
  const db = open(path, STATE_SCHEMA);
  db.prepare("ATTACH DATABASE ? AS src").run(opts.sourcePath);
  const present = new Set((db.prepare("SELECT name FROM src.sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
  const missing = ["dataset_meta", ...FINANCIAL_TABLES].filter((t) => !present.has(t));
  if (missing.length > 0) throw new Error(`Source database ${opts.sourcePath} is missing tables: ${missing.join(", ")}`);
  return db;
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
