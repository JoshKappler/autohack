import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { getConfig } from "../config";
import { resolve, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (_db) return _db;

  const config = getConfig();

  // If DB_PATH is relative, resolve from PROJECT_ROOT env var or CWD
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const dbPath = isAbsolute(config.DB_PATH)
    ? config.DB_PATH
    : resolve(projectRoot, config.DB_PATH);

  // Ensure data directory exists
  mkdirSync(resolve(dbPath, ".."), { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  _db = drizzle(sqlite, { schema });
  return _db;
}

export { schema };
