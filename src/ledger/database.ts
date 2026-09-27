/**
 * SQLite database bootstrap for the persistent ledger.
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

export interface LedgerDatabaseOptions {
  /** Path to the SQLite file. Parent directories are created if missing. */
  dbPath: string;
  /** Optional schema SQL override (defaults to schema.sql shipped with the app). */
  schemaSql?: string;
}

export function openLedgerDatabase(options: LedgerDatabaseOptions): Database.Database {
  const { dbPath } = options;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = options.schemaSql ?? readFileSync(join(dirname(new URL(import.meta.url).pathname), "schema.sql"), "utf-8");
  db.exec(schema);
  return db;
}
