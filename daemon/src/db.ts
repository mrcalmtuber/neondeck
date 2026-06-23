import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { DbColumn, DbRow, DbTableMeta } from "@ide/shared";

/**
 * Visual SQLite explorer backend (Feature 2).
 *
 * Uses Node's built-in `node:sqlite` (stable on Node 22.5+/26) so there is no
 * native build step and no extra dependency. The database file lives at
 * `<workspace>/storage.db` — inside the active project's jail, like every other
 * file op. The frontend never writes SQL; it sends structured row operations and
 * we translate them into parameterized statements here.
 */

export const DB_FILENAME = "storage.db";

/** Identifier guard: table/column names are never parameterizable in SQL, so we
 *  whitelist them strictly AND cross-check against the live schema before use. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MAX_ROWS = 500;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Invalid identifier: ${name}`);
  return name;
}

/** Open (creating if needed) the project's storage.db and seed a friendly
 *  starter table the first time so beginners don't stare at an empty grid. */
export function openDb(workspaceDir: string): { db: DatabaseSync; dbPath: string } {
  const abs = path.join(path.resolve(workspaceDir), DB_FILENAME);
  const db = new DatabaseSync(abs);
  // Default (rollback) journaling keeps a single storage.db file in the tree —
  // no lingering -wal/-shm sidecars to clutter the explorer.
  if (listTables(db).length === 0) {
    db.exec(
      `CREATE TABLE notes (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         title TEXT,
         body TEXT,
         done INTEGER DEFAULT 0
       );`,
    );
    const ins = db.prepare("INSERT INTO notes (title, body, done) VALUES (?, ?, ?)");
    ins.run("Welcome 👋", "Double-click any cell to edit it. Use + Row to add data.", 0);
    ins.run("Try it", "Click the trash icon to delete a row — no SQL required.", 0);
  }
  return { db, dbPath: DB_FILENAME };
}

/** User tables only (hide sqlite_* internals). */
export function listTables(db: DatabaseSync): DbTableMeta[] {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return names.map((r) => {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM "${ident(r.name)}"`).get() as { n: number };
    return { name: r.name, rowCount: Number(count.n) };
  });
}

function columnsOf(db: DatabaseSync, table: string): DbColumn[] {
  const info = db.prepare(`PRAGMA table_info("${ident(table)}")`).all() as {
    name: string;
    type: string;
    pk: number;
  }[];
  if (info.length === 0) throw new Error(`No such table: ${table}`);
  return info.map((c) => ({ name: c.name, type: c.type || "TEXT", pk: c.pk > 0 }));
}

/** SQLite scalars → JSON-safe values (BigInt and BLOB can't be JSON.stringified). */
function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return `«blob ${v.length}b»`;
  return v;
}

export function readTable(
  db: DatabaseSync,
  table: string,
): { columns: DbColumn[]; rows: DbRow[] } {
  const columns = columnsOf(db, table);
  const t = ident(table);
  let raw: Record<string, unknown>[];
  let hasRowid = true;
  try {
    raw = db.prepare(`SELECT rowid AS _rowid, * FROM "${t}" LIMIT ${MAX_ROWS}`).all() as Record<
      string,
      unknown
    >[];
  } catch {
    // WITHOUT ROWID tables have no rowid — read plainly; rows become read-only.
    hasRowid = false;
    raw = db.prepare(`SELECT * FROM "${t}" LIMIT ${MAX_ROWS}`).all() as Record<string, unknown>[];
  }
  const rows: DbRow[] = raw.map((r, i) => {
    const out: DbRow = { _rowid: hasRowid ? Number(r._rowid) : -1 - i };
    for (const c of columns) out[c.name] = jsonSafe(r[c.name]);
    return out;
  });
  return { columns, rows };
}

/** Insert a row using only columns that actually exist on the table. */
export function insertRow(
  db: DatabaseSync,
  table: string,
  values: Record<string, unknown>,
): void {
  const cols = columnsOf(db, table).filter((c) => !(c.pk && c.type.toUpperCase().includes("INT")));
  const used = cols.filter((c) => c.name in values);
  if (used.length === 0) {
    // No values supplied → insert an all-defaults row so the grid gains a line.
    db.exec(`INSERT INTO "${ident(table)}" DEFAULT VALUES`);
    return;
  }
  const colSql = used.map((c) => `"${ident(c.name)}"`).join(", ");
  const placeholders = used.map(() => "?").join(", ");
  const params = used.map((c) => coerce(values[c.name]));
  db.prepare(`INSERT INTO "${ident(table)}" (${colSql}) VALUES (${placeholders})`).run(...params);
}

export function updateCell(
  db: DatabaseSync,
  table: string,
  rowid: number,
  column: string,
  value: unknown,
): void {
  const cols = columnsOf(db, table);
  if (!cols.some((c) => c.name === column)) throw new Error(`No such column: ${column}`);
  if (rowid < 0) throw new Error("This table has no rowid; cells are read-only.");
  db.prepare(`UPDATE "${ident(table)}" SET "${ident(column)}" = ? WHERE rowid = ?`).run(
    coerce(value),
    rowid,
  );
}

export function deleteRow(db: DatabaseSync, table: string, rowid: number): void {
  if (rowid < 0) throw new Error("This table has no rowid; rows are read-only.");
  db.prepare(`DELETE FROM "${ident(table)}" WHERE rowid = ?`).run(rowid);
}

/** Create a new table: an auto-increment id PK plus the requested TEXT columns. */
export function createTable(db: DatabaseSync, table: string, columns: string[]): void {
  ident(table);
  const extra = columns
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c) => c.toLowerCase() !== "id")
    .map((c) => `"${ident(c)}" TEXT`);
  const defs = ["id INTEGER PRIMARY KEY AUTOINCREMENT", ...extra].join(", ");
  db.exec(`CREATE TABLE "${ident(table)}" (${defs})`);
}

/** SQLite bindings accept string/number/bigint/null/Uint8Array. Coerce the rest. */
function coerce(v: unknown): string | number | bigint | null | Uint8Array {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return String(v);
}
