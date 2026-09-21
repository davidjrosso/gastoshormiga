/**
 * Banco de pruebas.
 *
 * Cada corrida abre una base nueva en un directorio temporal, así los tests no
 * pisan `data/hormiga.db` ni dependen de lo que haya dejado el seed. Como
 * `db/index.ts` abre el archivo en el momento de importarse, `DATABASE_PATH`
 * tiene que estar seteado ANTES de ese import: por eso el import de abajo es
 * dinámico y no estático. Un `import` normal se hoistea y se evaluaría antes
 * que la línea que setea la variable, contra una base equivocada.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'hormiga-test-')), 'test.db');

const { sqlite } = await import('../src/db/index.js');
export { sqlite };

/** Fecha de hace `n` días en 'YYYY-MM-DD'. Los tests del detector trabajan
 *  sobre una ventana relativa a hoy, así que los fixtures también. */
export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** Primer día del período actual. */
export function thisPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

export interface Fixture {
  householdId: string;
  userId: string;
  otherUserId: string;
  accountId: string;
  categoryId: string;
}

/**
 * Hogar mínimo: dos personas, una cuenta, una categoría.
 * Dos personas porque la distinción entre quién pagó y quién cargó solo se
 * puede testear si hay alguien más.
 */
export function makeHousehold(fxRateType = 'blue'): Fixture {
  const householdId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const accountId = randomUUID();
  const categoryId = randomUUID();

  sqlite
    .prepare(`INSERT INTO households (id, name, base_currency, fx_rate_type) VALUES (?, ?, 'ARS', ?)`)
    .run(householdId, 'Hogar de prueba', fxRateType);

  const insertUser = sqlite.prepare(
    `INSERT INTO users (id, household_id, email, password_hash, display_name) VALUES (?, ?, ?, 'x', ?)`,
  );
  insertUser.run(userId, householdId, `${userId}@test.local`, 'Uno');
  insertUser.run(otherUserId, householdId, `${otherUserId}@test.local`, 'Dos');

  sqlite
    .prepare(`INSERT INTO accounts (id, household_id, name, type, currency) VALUES (?, ?, 'Caja', 'efectivo', 'ARS')`)
    .run(accountId, householdId);

  sqlite
    .prepare(`INSERT INTO categories (id, household_id, name, kind) VALUES (?, ?, 'Varios', 'gasto')`)
    .run(categoryId, householdId);

  return { householdId, userId, otherUserId, accountId, categoryId };
}

/** Sesión válida para pegarle a las rutas con `Cookie: hormiga_session=...`. */
export function makeSession(userId: string): string {
  const token = randomUUID();
  sqlite
    .prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, userId, Date.now() + 86_400_000);
  return token;
}

/** Vacía la tabla de cotizaciones. Es global al servidor, no por hogar, así que
 *  el test que necesita "no hay ninguna cargada" tiene que dejarla limpia. */
export function clearRates(): void {
  sqlite.prepare(`DELETE FROM fx_rates`).run();
}

export function makeMerchant(householdId: string, name: string): string {
  const id = randomUUID();
  sqlite
    .prepare(`INSERT INTO merchants (id, household_id, name, normalized_name) VALUES (?, ?, ?, ?)`)
    .run(id, householdId, name, name.toLowerCase());
  return id;
}

export function addTx(f: Fixture, tx: {
  type?: 'gasto' | 'ingreso' | 'transferencia';
  date: string;
  amountMinor: number;
  merchantId?: string | null;
  categoryId?: string | null;
  usdRateMinor?: number | null;
  paidByUserId?: string | null;
}): string {
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO transactions
         (id, household_id, type, date, account_id, amount_minor, currency,
          category_id, merchant_id, paid_by_user_id, usd_rate_minor)
       VALUES (?, ?, ?, ?, ?, ?, 'ARS', ?, ?, ?, ?)`,
    )
    .run(
      id,
      f.householdId,
      tx.type ?? 'gasto',
      tx.date,
      f.accountId,
      tx.amountMinor,
      tx.categoryId === undefined ? f.categoryId : tx.categoryId,
      tx.merchantId ?? null,
      tx.paidByUserId ?? null,
      tx.usdRateMinor ?? null,
    );
  return id;
}

/** Carga una cotización. `sellMinor` son centavos de ARS por 1 USD. */
export function setRate(date: string, type: string, sellMinor: number): void {
  sqlite
    .prepare(
      `INSERT INTO fx_rates (date, type, buy_minor, sell_minor, source)
       VALUES (?, ?, ?, ?, 'test')
       ON CONFLICT (date, type) DO UPDATE SET sell_minor = excluded.sell_minor`,
    )
    .run(date, type, sellMinor, sellMinor);
}

/** Ingreso mensual parejo en la ventana. El umbral del detector se calcula
 *  contra esto, así que sin ingresos los tests no prueban lo que creen. */
export function addMonthlyIncome(f: Fixture, monthlyMinor: number, months = 3): void {
  for (let i = 0; i < months; i++) {
    addTx(f, { type: 'ingreso', date: daysAgo(i * 30 + 1), amountMinor: monthlyMinor, categoryId: null });
  }
}
