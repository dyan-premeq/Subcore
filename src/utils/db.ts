import { Database } from 'bun:sqlite'
import { indexDbPath } from './env'

let db: Database | undefined

export function readDb(): Database {
  return db ??= new Database(indexDbPath, { readonly: true })
}
