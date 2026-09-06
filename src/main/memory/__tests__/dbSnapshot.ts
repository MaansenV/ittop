import { DatabaseSync } from 'node:sqlite'

/**
 * Deterministic whole-database snapshot for side-effect proofs: the
 * COMPLETE sqlite_master (all types incl. sqlite_* internals) plus every
 * table's rows as a multiset (WITHOUT ROWID safe, >2^53 INTEGER safe via
 * TEXT cast). Open readOnly + query_only by the caller.
 */
export function snapshotDb(dbFile: string): string {
  const d = new DatabaseSync(dbFile, { readOnly: true })
  try {
    d.exec('PRAGMA query_only = ON')
    const master = d.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all()
    const out: Record<string, unknown> = { sqlite_master: master }
    const tables = (
      d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{
        name: string
      }>
    )
    for (const t of tables) {
      const safe = t.name.replace(/"/g, '')
      const cols = d.prepare(`PRAGMA table_info("${safe}")`).all() as Array<{ name: string; type: string }>
      const select = cols
        .map((c) =>
          /int/i.test(c.type)
            ? `CAST("${c.name.replace(/"/g, '')}" AS TEXT) AS "${c.name.replace(/"/g, '')}"`
            : `"${c.name.replace(/"/g, '')}"`,
        )
        .join(', ')
      const rows = (d.prepare(`SELECT ${select} FROM "${safe}"`).all() as Array<Record<string, unknown>>)
        .map((r) => JSON.stringify(r))
        .sort()
      out[t.name] = { rows }
    }
    return JSON.stringify(out)
  } finally {
    d.close()
  }
}

/** Consistent snapshot via VACUUM INTO into a separate file. Transactional
 * on the source (no tearing under concurrent writers/checkpoints), works
 * on column-encrypted DBs (pager-level copy), writable target for verify.
 * Destination path is quote-escaped (VACUUM INTO takes no bound param). */
export function vacuumIntoSnapshot(srcDb: string, destDb: string): void {
  const d = new DatabaseSync(srcDb, { readOnly: true })
  try {
    d.exec(`VACUUM INTO '${destDb.replace(/'/g, "''")}'`)
  } finally {
    d.close()
  }
}
