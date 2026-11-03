import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/**
 * Thin adapter over Node's built-in `node:sqlite` (no native dependency, nothing to compile on install).
 * It keeps the small better-sqlite3-style surface the engine was written against: prepare/exec/pragma/close
 * and a `transaction(fn)` wrapper. Binding follows better-sqlite3's rules, which are stricter where it
 * matters: a named parameter missing from the object throws (node:sqlite would bind NULL), and extra keys
 * in the object are ignored (node:sqlite would throw), so `stmt.run({ ...row, extra })` keeps working.
 */

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

type Param = unknown;

/** Named parameters (@name, :name, $name) outside string literals, in the order they appear. */
function namedParameters(sql: string): string[] {
  const code = sql.replace(/'(?:[^']|'')*'/g, "''");
  return [...new Set([...code.matchAll(/[@:$]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v) && !(v instanceof Date);

export class Statement {
  readonly #stmt: StatementSync;
  readonly #names: string[];

  constructor(stmt: StatementSync, sql: string) {
    this.#stmt = stmt;
    this.#names = namedParameters(sql);
  }

  /** Split call arguments into node:sqlite's (named object, positional values) form. Arrays are flattened. */
  #bind(params: Param[]): [Record<string, SQLInputValue> | null, SQLInputValue[]] {
    const flat = params.flat();
    if (flat.length > 0 && isPlainObject(flat[0])) {
      const obj = flat[0];
      const named: Record<string, SQLInputValue> = {};
      for (const name of this.#names) {
        if (!(name in obj)) throw new RangeError(`Missing named parameter "${name}"`);
        named[name] = obj[name] as SQLInputValue;
      }
      return [named, flat.slice(1) as SQLInputValue[]];
    }
    return [null, flat as SQLInputValue[]];
  }

  run(...params: Param[]): RunResult {
    const [named, values] = this.#bind(params);
    return named ? this.#stmt.run(named, ...values) : this.#stmt.run(...values);
  }

  get(...params: Param[]): unknown {
    const [named, values] = this.#bind(params);
    return named ? this.#stmt.get(named, ...values) : this.#stmt.get(...values);
  }

  all(...params: Param[]): unknown[] {
    const [named, values] = this.#bind(params);
    return named ? this.#stmt.all(named, ...values) : this.#stmt.all(...values);
  }
}

export class Database {
  readonly #db: DatabaseSync;
  #depth = 0;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
  }

  prepare(sql: string): Statement {
    return new Statement(this.#db.prepare(sql), sql);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  /** `db.pragma("journal_mode = WAL")`. Returns the pragma's rows (empty for most setters). */
  pragma(source: string): unknown[] {
    return this.#db.prepare(`PRAGMA ${source}`).all();
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  /**
   * Wrap `fn` so each call runs in one transaction: BEGIN … COMMIT, or ROLLBACK if `fn` throws (the error
   * is rethrown). A nested call becomes a SAVEPOINT, so an inner failure undoes only the inner work.
   * `fn` must be synchronous: an async function would commit before its awaited work ran.
   */
  transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
    return (...args: A): T => {
      const level = this.#depth;
      const savepoint = `closeloop_sp_${level}`;
      const undo = () => this.#db.exec(level > 0 ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      this.#db.exec(level > 0 ? `SAVEPOINT ${savepoint}` : "BEGIN");
      this.#depth = level + 1;
      let result: T;
      try {
        result = fn(...args);
        if (result instanceof Promise) throw new TypeError("transaction(fn): fn must be synchronous, not return a Promise");
      } catch (err) {
        this.#depth = level;
        undo();
        throw err;
      }
      this.#depth = level;
      try {
        this.#db.exec(level > 0 ? `RELEASE ${savepoint}` : "COMMIT");
      } catch (err) {
        // A failed COMMIT (e.g. a deferred constraint) leaves the transaction open; close it before rethrowing.
        undo();
        throw err;
      }
      return result;
    };
  }

  close(): void {
    this.#db.close();
  }
}
