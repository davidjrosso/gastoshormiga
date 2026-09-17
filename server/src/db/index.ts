import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runMigrations } from './migrate.js';
import * as schema from './schema.js';

const DB_PATH = process.env.DATABASE_PATH
  ? resolve(process.env.DATABASE_PATH)
  : resolve(process.cwd(), 'data', 'hormiga.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const sqlite = new Database(DB_PATH);

// WAL: permite leer mientras se escribe. Con dos usuarios cargando gastos
// desde el celular al mismo tiempo, evita bloqueos espurios.
sqlite.pragma('journal_mode = WAL');
// Las FK en SQLite vienen apagadas por defecto, lo cual es una trampa.
sqlite.pragma('foreign_keys = ON');
// Espera hasta 5s si la base está bloqueada en vez de fallar al instante.
sqlite.pragma('busy_timeout = 5000');

const migration = runMigrations(sqlite);
if (migration.from !== migration.to) {
  console.log(`[db] migrada de v${migration.from} a v${migration.to}`);
}

export const db = drizzle(sqlite, { schema });
export { schema, DB_PATH };
