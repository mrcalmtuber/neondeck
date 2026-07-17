import { useEffect, useState } from "react";
import type { DbColumn, DbRow, DbTableMeta } from "@ide/shared";
import { daemon } from "../lib/daemonClient";

/**
 * Feature 2 — Visual SQLite Database Explorer.
 *
 * On open, the daemon provisions/opens `storage.db` in the active project. This
 * grid lets beginners view tables, add rows, edit cells (double-click), and
 * delete rows — no SQL typed by hand. Every mutation round-trips to the daemon,
 * which runs a parameterized statement and returns the fresh rows.
 */
export function DatabaseExplorer() {
  const [tables, setTables] = useState<DbTableMeta[]>([]);
  const [dbPath, setDbPath] = useState("storage.db");
  const [active, setActive] = useState<string | null>(null);
  const [columns, setColumns] = useState<DbColumn[]>([]);
  const [rows, setRows] = useState<DbRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ rowid: number; column: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCols, setNewCols] = useState("");

  async function loadSchema(selectFirst = true) {
    setError(null);
    try {
      const { dbPath, tables } = await daemon.dbOpen();
      setDbPath(dbPath);
      setTables(tables);
      if (selectFirst && tables.length && !tables.some((t) => t.name === active)) {
        setActive(tables[0].name);
      } else if (!tables.length) {
        setActive(null);
        setColumns([]);
        setRows([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadRows(table: string) {
    setError(null);
    try {
      const { columns, rows } = await daemon.dbRead(table);
      setColumns(columns);
      setRows(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Open the DB once when the tab mounts.
  useEffect(() => {
    loadSchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload rows whenever the active table changes.
  useEffect(() => {
    if (active) loadRows(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function apply(res: { columns: DbColumn[]; rows: DbRow[] }) {
    setColumns(res.columns);
    setRows(res.rows);
  }

  async function addRow() {
    if (!active) return;
    try {
      apply(await daemon.dbInsert(active, {}));
      loadSchema(false); // refresh row counts
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteRow(rowid: number) {
    if (!active) return;
    try {
      apply(await daemon.dbDelete(active, rowid));
      loadSchema(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function beginEdit(rowid: number, column: string, current: unknown) {
    if (rowid < 0) return; // read-only (no rowid)
    setEditing({ rowid, column });
    setDraft(current == null ? "" : String(current));
  }

  async function commitEdit() {
    if (!editing || !active) return;
    const { rowid, column } = editing;
    setEditing(null);
    try {
      apply(await daemon.dbUpdate(active, rowid, column, draft));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createTable() {
    const name = newName.trim();
    if (!name) return;
    const cols = newCols.split(",").map((c) => c.trim()).filter(Boolean);
    try {
      const t = await daemon.dbCreateTable(name, cols);
      setTables(t);
      setActive(name);
      setCreating(false);
      setNewName("");
      setNewCols("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="db-explorer">
      <div className="db-toolbar">
        <span className="db-title">🗄️ Database</span>
        <code className="db-path">{dbPath}</code>
        <div className="db-tabs">
          {tables.map((t) => (
            <button
              key={t.name}
              className={`db-tab ${active === t.name ? "active" : ""}`}
              onClick={() => setActive(t.name)}
            >
              {t.name} <span className="db-count">{t.rowCount}</span>
            </button>
          ))}
        </div>
        <button className="btn-ghost sm" onClick={() => setCreating((c) => !c)} title="New table">
          ＋ Table
        </button>
        <button className="btn-ghost sm" onClick={() => loadSchema(false)} title="Refresh">
          ⟳
        </button>
      </div>

      {creating && (
        <div className="db-create">
          <input
            placeholder="table name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            spellCheck={false}
          />
          <input
            placeholder="columns, comma separated (e.g. name, email, age)"
            value={newCols}
            onChange={(e) => setNewCols(e.target.value)}
            spellCheck={false}
          />
          <button className="btn-primary sm" onClick={createTable}>
            Create
          </button>
          <span className="muted db-create-hint">an auto-increment <code>id</code> PK is added for you</span>
        </div>
      )}

      {error && <div className="db-error">⚠️ {error}</div>}

      {loading ? (
        <div className="db-empty muted">
          <span className="spinner" /> Opening storage.db…
        </div>
      ) : !active ? (
        <div className="db-empty muted">No tables yet. Click ＋ Table to create one.</div>
      ) : (
        <div className="db-grid-wrap">
          <table className="db-grid">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.name}>
                    {c.name}
                    {c.pk && <span className="db-pk" title="primary key">🔑</span>}
                    <span className="db-type">{c.type}</span>
                  </th>
                ))}
                <th className="db-actions-col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._rowid}>
                  {columns.map((c) => {
                    const isEditing =
                      editing?.rowid === r._rowid && editing?.column === c.name;
                    const val = r[c.name];
                    return (
                      <td
                        key={c.name}
                        className={val == null ? "db-null" : ""}
                        onDoubleClick={() => beginEdit(r._rowid, c.name, val)}
                        title={r._rowid < 0 ? "read-only (table has no rowid)" : "double-click to edit"}
                      >
                        {isEditing ? (
                          <input
                            className="db-cell-input"
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitEdit();
                              if (e.key === "Escape") setEditing(null);
                            }}
                          />
                        ) : val == null ? (
                          "NULL"
                        ) : (
                          String(val)
                        )}
                      </td>
                    );
                  })}
                  <td className="db-actions-col">
                    {r._rowid >= 0 && (
                      <button
                        className="db-del"
                        title="Delete row"
                        onClick={() => deleteRow(r._rowid)}
                      >
                        🗑️
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="db-empty-row muted" colSpan={columns.length + 1}>
                    No rows yet — click “＋ Row” below.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {active && (
        <div className="db-footer">
          <button className="btn-primary sm" onClick={addRow}>
            ＋ Row
          </button>
          <span className="muted">{rows.length} row(s) shown · double-click a cell to edit</span>
        </div>
      )}
    </div>
  );
}
