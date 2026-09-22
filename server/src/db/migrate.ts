import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migraciones versionadas con `PRAGMA user_version`.
 *
 * Es deliberadamente de andar por casa: sin drizzle-kit, sin archivos sueltos,
 * sin CLI extra que instalar en el server. Para una app de dos usuarios el
 * costo de una herramienta de migraciones supera al beneficio.
 *
 * Para agregar una migración: empujá un string más al final del array.
 * NUNCA edites ni reordenes las existentes: ya corrieron en tu base.
 */
const MIGRATIONS: string[] = [
  // v1 — esquema inicial
  `
  CREATE TABLE households (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    base_currency  TEXT NOT NULL DEFAULT 'ARS',
    fx_rate_type   TEXT NOT NULL DEFAULT 'blue',
    created_at     INTEGER
  );

  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    household_id  TEXT NOT NULL REFERENCES households(id),
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    INTEGER
  );
  CREATE UNIQUE INDEX users_email_idx ON users(email);

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    created_at INTEGER
  );
  CREATE INDEX sessions_user_idx ON sessions(user_id);

  CREATE TABLE accounts (
    id                     TEXT PRIMARY KEY,
    household_id           TEXT NOT NULL REFERENCES households(id),
    name                   TEXT NOT NULL,
    type                   TEXT NOT NULL,
    currency               TEXT NOT NULL DEFAULT 'ARS',
    opening_balance_minor  INTEGER NOT NULL DEFAULT 0,
    archived               INTEGER NOT NULL DEFAULT 0,
    sort_order             INTEGER NOT NULL DEFAULT 0,
    created_at             INTEGER
  );
  CREATE INDEX accounts_household_idx ON accounts(household_id);

  CREATE TABLE categories (
    id           TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'gasto',
    parent_id    TEXT,
    is_fixed     INTEGER NOT NULL DEFAULT 0,
    color        TEXT NOT NULL DEFAULT '#64748b',
    icon         TEXT NOT NULL DEFAULT '.',
    archived     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER
  );
  CREATE INDEX categories_household_idx ON categories(household_id);

  CREATE TABLE merchants (
    id                  TEXT PRIMARY KEY,
    household_id        TEXT NOT NULL REFERENCES households(id),
    name                TEXT NOT NULL,
    normalized_name     TEXT NOT NULL,
    default_category_id TEXT,
    created_at          INTEGER
  );
  CREATE UNIQUE INDEX merchants_household_name_idx ON merchants(household_id, normalized_name);

  CREATE TABLE transactions (
    id                 TEXT PRIMARY KEY,
    household_id       TEXT NOT NULL REFERENCES households(id),
    type               TEXT NOT NULL,
    date               TEXT NOT NULL,
    account_id         TEXT NOT NULL REFERENCES accounts(id),
    amount_minor       INTEGER NOT NULL,
    currency           TEXT NOT NULL DEFAULT 'ARS',
    to_account_id      TEXT,
    amount_to_minor    INTEGER,
    currency_to        TEXT,
    category_id        TEXT,
    merchant_id        TEXT,
    note               TEXT,
    paid_by_user_id    TEXT,
    created_by_user_id TEXT,
    recurring_rule_id  TEXT,
    usd_rate_minor     INTEGER,
    created_at         INTEGER,
    updated_at         INTEGER
  );
  CREATE INDEX tx_household_date_idx ON transactions(household_id, date);
  CREATE INDEX tx_merchant_idx ON transactions(merchant_id);
  CREATE INDEX tx_category_idx ON transactions(category_id);
  CREATE INDEX tx_account_idx ON transactions(account_id);

  CREATE TABLE recurring_rules (
    id                    TEXT PRIMARY KEY,
    household_id          TEXT NOT NULL REFERENCES households(id),
    description           TEXT NOT NULL,
    amount_minor          INTEGER NOT NULL,
    currency              TEXT NOT NULL DEFAULT 'ARS',
    account_id            TEXT NOT NULL,
    category_id           TEXT,
    merchant_id           TEXT,
    day_of_month          INTEGER NOT NULL DEFAULT 1,
    active                INTEGER NOT NULL DEFAULT 1,
    last_generated_period TEXT,
    created_at            INTEGER
  );
  CREATE INDEX recurring_household_idx ON recurring_rules(household_id);

  CREATE TABLE fx_rates (
    date       TEXT NOT NULL,
    type       TEXT NOT NULL,
    buy_minor  INTEGER NOT NULL,
    sell_minor INTEGER NOT NULL,
    source     TEXT NOT NULL DEFAULT 'dolarapi',
    fetched_at INTEGER
  );
  CREATE UNIQUE INDEX fx_date_type_idx ON fx_rates(date, type);

  CREATE TABLE holdings (
    id             TEXT PRIMARY KEY,
    household_id   TEXT NOT NULL REFERENCES households(id),
    account_id     TEXT NOT NULL REFERENCES accounts(id),
    ticker         TEXT NOT NULL,
    quantity       INTEGER NOT NULL DEFAULT 0,
    avg_cost_minor INTEGER NOT NULL DEFAULT 0,
    currency       TEXT NOT NULL DEFAULT 'ARS',
    updated_at     INTEGER
  );
  CREATE INDEX holdings_household_idx ON holdings(household_id);
  `,

  // v2 — quién paga un gasto fijo
  //
  // Los fijos materializados nacían sin `paid_by_user_id`, así que el alquiler,
  // las expensas y la prepaga —lo más pesado del mes— quedaban afuera de
  // "Quién pagó qué". La regla es el único lugar donde esa información puede
  // vivir: el gasto lo genera el sistema, no la persona que abre la app.
  // Nullable a propósito: un fijo que sale de la cuenta conjunta no es de nadie.
  `
  ALTER TABLE recurring_rules ADD COLUMN paid_by_user_id TEXT;
  `,
  // v3 - independent statement ledger; existing transactions are untouched.
  `
  CREATE TABLE card_statements (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    source_hash TEXT NOT NULL,
    source_name TEXT NOT NULL,
    account_id TEXT REFERENCES accounts(id),
    close_date TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft','confirmed')),
    revision INTEGER NOT NULL DEFAULT 1,
    document_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(household_id, source_hash)
  );
  CREATE UNIQUE INDEX card_statement_period ON card_statements(household_id, account_id, close_date)
    WHERE status = 'confirmed';
  CREATE TABLE card_settlements (
    id TEXT PRIMARY KEY,
    statement_id TEXT NOT NULL REFERENCES card_statements(id),
    holder TEXT NOT NULL,
    currency TEXT NOT NULL CHECK(currency IN ('ARS','USD')),
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    kind TEXT NOT NULL CHECK(kind IN ('payment','assumed')),
    date TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX card_settlements_statement ON card_settlements(statement_id);
  `,
];

export function runMigrations(db: BetterSqlite3.Database): { from: number; to: number } {
  const current = db.pragma('user_version', { simple: true }) as number;
  const target = MIGRATIONS.length;

  // Two development branches used v3 for different features. Refuse an
  // incompatible schema instead of accepting user_version alone.
  if (current >= 3 && (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='card_statements'").get()
    || !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='card_settlements'").get())) {
    throw new Error('Esquema de tarjeta incompatible: esta base pertenece a otra rama. No intercambiar versiones sin una migracion explicita.');
  }

  if (current > target) {
    throw new Error(
      `La base está en la versión ${current} pero este código solo conoce hasta la ${target}. ` +
      `Estás corriendo un binario más viejo que la base. Actualizá el código.`
    );
  }

  for (let v = current; v < target; v++) {
    const sql = MIGRATIONS[v];
    // Cada migración es atómica: o entra entera o no entra.
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Falló la migración v${v + 1}: ${(err as Error).message}`);
    }
  }

  return { from: current, to: target };
}
