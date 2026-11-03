import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/db/sqlite.ts";

let db: Database;
const total = () => (db.prepare("SELECT COALESCE(SUM(paise), 0) AS n FROM t").get() as { n: number }).n;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, paise INTEGER NOT NULL) STRICT;
           CREATE TABLE locked (id TEXT PRIMARY KEY) STRICT;
           CREATE TRIGGER locked_no_delete BEFORE DELETE ON locked BEGIN SELECT RAISE(ABORT, 'locked is insert-only'); END;`);
});

describe("node:sqlite adapter: transaction(fn)", () => {
  it("commits and returns the function's result, passing arguments through", () => {
    const insert = db.transaction((id: string, paise: number) => db.prepare("INSERT INTO t (id, paise) VALUES (?, ?)").run(id, paise).changes);
    expect(insert("a", 100)).toBe(1);
    expect(total()).toBe(100);
    expect(db.inTransaction).toBe(false);
  });

  it("rolls back everything and rethrows when fn throws", () => {
    const boom = new Error("boom");
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t (id, paise) VALUES ('a', 100)").run();
        throw boom;
      })(),
    ).toThrow(boom);
    expect(total()).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  it("rolls back when a statement inside fails (insert-only trigger)", () => {
    db.prepare("INSERT INTO locked (id) VALUES ('x')").run();
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t (id, paise) VALUES ('a', 100)").run();
        db.prepare("DELETE FROM locked").run();
      })(),
    ).toThrow(/insert-only/);
    expect(total()).toBe(0);
  });

  it("nests as a savepoint: an inner failure undoes only the inner work", () => {
    db.transaction(() => {
      db.prepare("INSERT INTO t (id, paise) VALUES ('outer', 1)").run();
      expect(() =>
        db.transaction(() => {
          db.prepare("INSERT INTO t (id, paise) VALUES ('inner', 10)").run();
          throw new Error("inner");
        })(),
      ).toThrow("inner");
      db.transaction(() => db.prepare("INSERT INTO t (id, paise) VALUES ('inner2', 100)").run())();
    })();
    expect(total()).toBe(101);
  });

  it("an outer failure also undoes committed inner savepoints", () => {
    expect(() =>
      db.transaction(() => {
        db.transaction(() => db.prepare("INSERT INTO t (id, paise) VALUES ('inner', 10)").run())();
        throw new Error("outer");
      })(),
    ).toThrow("outer");
    expect(total()).toBe(0);
  });

  it("refuses an async fn and rolls back its synchronous part", () => {
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t (id, paise) VALUES ('a', 100)").run();
        return Promise.resolve();
      })(),
    ).toThrow(/synchronous/);
    expect(total()).toBe(0);
    // The connection is usable afterwards.
    db.transaction(() => db.prepare("INSERT INTO t (id, paise) VALUES ('b', 5)").run())();
    expect(total()).toBe(5);
  });
});

describe("node:sqlite adapter: parameter binding", () => {
  it("binds named parameters and ignores extra keys", () => {
    db.prepare("INSERT INTO t (id, paise) VALUES (@id, @paise)").run({ id: "a", paise: 7, details: { not: "bound" } });
    expect(total()).toBe(7);
  });

  it("throws on a missing named parameter instead of binding NULL", () => {
    expect(() => db.prepare("INSERT INTO t (id, paise) VALUES (@id, @paise)").run({ id: "a" })).toThrow(/Missing named parameter "paise"/);
  });

  it("does not mistake text inside string literals for parameters", () => {
    db.prepare("INSERT INTO t (id, paise) VALUES ('2026-10-01T10:00:00+05:30 @x :y', @paise)").run({ paise: 3 });
    expect(total()).toBe(3);
  });

  it("binds positional parameters, spread or as an array", () => {
    db.prepare("INSERT INTO t (id, paise) VALUES (?, ?)").run("a", 1);
    db.prepare("INSERT INTO t (id, paise) VALUES (?, ?)").run(["b", 2]);
    expect(db.prepare("SELECT id FROM t WHERE paise IN (?, ?) ORDER BY id").all(1, 2)).toEqual([{ id: "a" }, { id: "b" }]);
    expect(db.prepare("SELECT id FROM t WHERE id = ?").get("missing")).toBeUndefined();
  });

  it("rejects fractional money in a STRICT integer column", () => {
    expect(() => db.prepare("INSERT INTO t (id, paise) VALUES (?, ?)").run("a", 1.5)).toThrow();
  });
});
