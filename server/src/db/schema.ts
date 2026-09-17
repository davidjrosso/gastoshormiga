import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';

/**
 * Convenciones de este esquema
 * ----------------------------
 * - Todos los montos son ENTEROS en unidades menores (centavos ARS / cents USD).
 *   Nunca float: 0.1 + 0.2 !== 0.3 y en plata eso es inaceptable.
 * - Las fechas de negocio son TEXT 'YYYY-MM-DD' (hora local del hogar, no UTC).
 *   Un gasto del 3 a las 23:50 pertenece al día 3, no al 4 en Londres.
 * - `usdRateMinor` es centavos de ARS por 1 USD (blue a 1450 => 145000).
 *   Se congela en cada transacción para poder valuar el pasado en dólares
 *   sin que la inflación distorsione las comparaciones entre meses.
 */

const id = () => text('id').primaryKey().$defaultFn(() => randomUUID());
const now = () => integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date());

export const households = sqliteTable('households', {
  id: id(),
  name: text('name').notNull(),
  baseCurrency: text('base_currency').notNull().default('ARS'),
  // Qué cotización usa el hogar para valuar en USD: blue, oficial, mep.
  fxRateType: text('fx_rate_type').notNull().default('blue'),
  createdAt: now(),
});

export const users = sqliteTable('users', {
  id: id(),
  householdId: text('household_id').notNull().references(() => households.id),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: now(),
}, (t) => ({
  emailIdx: uniqueIndex('users_email_idx').on(t.email),
}));

export const sessions = sqliteTable('sessions', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: now(),
}, (t) => ({
  userIdx: index('sessions_user_idx').on(t.userId),
}));

/**
 * Cuentas = dónde está la plata. El tipo importa para el análisis:
 * lo que sale de una cuenta `ahorro` no es gasto, es desahorro.
 */
export const accounts = sqliteTable('accounts', {
  id: id(),
  householdId: text('household_id').notNull().references(() => households.id),
  name: text('name').notNull(),
  // efectivo | banco | tarjeta | ahorro | inversion
  type: text('type').notNull(),
  currency: text('currency').notNull().default('ARS'),
  // Saldo inicial al dar de alta la cuenta, en unidades menores.
  openingBalanceMinor: integer('opening_balance_minor').notNull().default(0),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: now(),
}, (t) => ({
  householdIdx: index('accounts_household_idx').on(t.householdId),
}));

export const categories = sqliteTable('categories', {
  id: id(),
  householdId: text('household_id').notNull().references(() => households.id),
  name: text('name').notNull(),
  // gasto | ingreso
  kind: text('kind').notNull().default('gasto'),
  parentId: text('parent_id'),
  // Marca las categorías que son gasto fijo estructural (alquiler, expensas).
  // Separarlas del día a día es lo que permite ver el gasto discrecional real.
  isFixed: integer('is_fixed', { mode: 'boolean' }).notNull().default(false),
  color: text('color').notNull().default('#64748b'),
  icon: text('icon').notNull().default('•'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: now(),
}, (t) => ({
  householdIdx: index('categories_household_idx').on(t.householdId),
}));

/**
 * Comercios. Es la tabla que hace posible detectar el gasto hormiga:
 * agrupar por categoría te dice "gastaste $80.000 en Comida".
 * Agrupar por comercio te dice "gastaste $28.000 en el café de la esquina,
 * en 14 compras de $2.000". Solo la segunda te permite decidir algo.
 */
export const merchants = sqliteTable('merchants', {
  id: id(),
  householdId: text('household_id').notNull().references(() => households.id),
  name: text('name').notNull(),
  // Nombre normalizado (minúsculas, sin acentos ni ruido) para agrupar
  // "Café Martinez", "CAFE MARTINEZ" y "cafe martinez  " como uno solo.
  normalizedName: text('normalized_name').notNull(),
  defaultCategoryId: text('default_category_id'),
  createdAt: now(),
}, (t) => ({
  householdNameIdx: uniqueIndex('merchants_household_name_idx').on(t.householdId, t.normalizedName),
}));

/**
 * Transacciones. Tres tipos, y la distinción no es cosmética:
 *
 *  - gasto        : la plata sale del hogar.
 *  - ingreso      : la plata entra al hogar.
 *  - transferencia: la plata cambia de lugar pero NO sale del hogar.
 *
 * Comprar USD es una TRANSFERENCIA (ARS sale de la cuenta banco, USD entra
 * a la cuenta ahorro), jamás un gasto. Es el bug clásico de estas apps:
 * te computan la compra de dólares como gasto y te arruinan el mes entero.
 */
export const transactions = sqliteTable('transactions', {
  id: id(),
  householdId: text('household_id').notNull().references(() => households.id),
  // gasto | ingreso | transferencia
  type: text('type').notNull(),
  date: text('date').notNull(), // YYYY-MM-DD

  accountId: text('account_id').notNull().references(() => accounts.id),
  amountMinor: integer('amount_minor').notNull(), // siempre positivo
  currency: text('currency').notNull().default('ARS'),

  // Solo para transferencias: destino y monto recibido.
  // Si comprás USD 100 a 1450, acá va la cuenta USD y amountToMinor = 10000.
  toAccountId: text('to_account_id'),
  amountToMinor: integer('amount_to_minor'),
  currencyTo: text('currency_to'),

  categoryId: text('category_id'),
  merchantId: text('merchant_id'),
  note: text('note'),

  // Quién puso la plata vs. quién cargó el dato. En una pareja no siempre coinciden.
  paidByUserId: text('paid_by_user_id'),
  createdByUserId: text('created_by_user_id'),

  recurringRuleId: text('recurring_rule_id'),

  // Cotización congelada al momento del movimiento (centavos ARS por 1 USD).
  usdRateMinor: integer('usd_rate_minor'),

  createdAt: now(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
}, (t) => ({
  householdDateIdx: index('tx_household_date_idx').on(t.householdId, t.date),
  merchantIdx: index('tx_merchant_idx').on(t.merchantId),
  categoryIdx: index('tx_category_idx').on(t.categoryId),
  accountIdx: index('tx_account_idx').on(t.accountId),
}));

/**
 * Gastos fijos. No son transacciones: son la regla que las genera.
 * Se materializan una vez por mes para que aparezcan en el flujo real.
 */
export const recurringRules = sqliteTable('recurring_rules', {
  id: id(),
  householdId: text('household_id').notNull().references(() => households.id),
  description: text('description').notNull(),
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull().default('ARS'),
  accountId: text('account_id').notNull(),
  categoryId: text('category_id'),
  merchantId: text('merchant_id'),
  dayOfMonth: integer('day_of_month').notNull().default(1),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  // Último período materializado, 'YYYY-MM'. Evita duplicar al re-ejecutar.
  lastGeneratedPeriod: text('last_generated_period'),
  createdAt: now(),
}, (t) => ({
  householdIdx: index('recurring_household_idx').on(t.householdId),
}));

/**
 * Cotizaciones diarias. Se traen de una API pública y quedan cacheadas.
 * Sin esto no hay forma honesta de comparar un mes contra otro en Argentina.
 */
export const fxRates = sqliteTable('fx_rates', {
  date: text('date').notNull(), // YYYY-MM-DD
  // blue | oficial | mep | cripto
  type: text('type').notNull(),
  buyMinor: integer('buy_minor').notNull(),
  sellMinor: integer('sell_minor').notNull(),
  source: text('source').notNull().default('dolarapi'),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
}, (t) => ({
  dateTypeIdx: uniqueIndex('fx_date_type_idx').on(t.date, t.type),
}));

/**
 * Tenencias de inversión. Vacío por ahora: es el gancho para la 2da etapa
 * con IOL, para no tener que migrar el esquema cuando lleguemos ahí.
 */
export const holdings = sqliteTable('holdings', {
  id: id(),
  householdId: text('household_id').notNull().references(() => households.id),
  accountId: text('account_id').notNull().references(() => accounts.id),
  ticker: text('ticker').notNull(),
  quantity: integer('quantity').notNull().default(0),
  avgCostMinor: integer('avg_cost_minor').notNull().default(0),
  currency: text('currency').notNull().default('ARS'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
}, (t) => ({
  householdIdx: index('holdings_household_idx').on(t.householdId),
}));

export type Household = typeof households.$inferSelect;
export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Merchant = typeof merchants.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type RecurringRule = typeof recurringRules.$inferSelect;
export type FxRate = typeof fxRates.$inferSelect;
