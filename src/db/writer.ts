import { Database } from 'bun:sqlite'
import { ensureSchema } from './schema'

/** Standalone index commands publish their replacement atomically and invalidate the sync cache. */
export async function withIndexWriter(dbPath: string, write: (db: Database) => Promise<void>): Promise<void> {
  const db = new Database(dbPath)
  try {
    db.run('BEGIN IMMEDIATE')
    ensureSchema(db)
    db.run("DELETE FROM meta WHERE key = 'sync_state'")
    await write(db)
    db.run('COMMIT')
  } catch (error) {
    if (db.inTransaction) db.run('ROLLBACK')
    throw error
  } finally {
    db.close(true)
  }
}
