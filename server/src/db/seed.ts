import { db, sqlite } from './index.js';
import { accounts, categories, households, merchants, transactions, users } from './schema.js';
import { normalizeMerchantName, todayISO } from '../lib/money.js';
import { hashPassword } from '../auth.js';

/**
 * Categorías por defecto pensadas para un hogar argentino.
 *
 * `isFixed` no es decorativo: separa el gasto estructural (que solo cambia si
 * te mudás o das de baja un servicio) del discrecional (donde sí podés decidir
 * algo este mes). Mezclarlos es lo que hace inútil a la mayoría de estas apps.
 */
const DEFAULT_CATEGORIES: Array<{ name: string; kind: 'gasto' | 'ingreso'; isFixed: boolean; color: string; icon: string }> = [
  // Gastos fijos
  { name: 'Alquiler',          kind: 'gasto',   isFixed: true,  color: '#ef4444', icon: '🏠' },
  { name: 'Expensas',          kind: 'gasto',   isFixed: true,  color: '#f97316', icon: '🏢' },
  { name: 'Luz, gas y agua',   kind: 'gasto',   isFixed: true,  color: '#eab308', icon: '💡' },
  { name: 'Internet y celular',kind: 'gasto',   isFixed: true,  color: '#06b6d4', icon: '📶' },
  { name: 'Prepaga',           kind: 'gasto',   isFixed: true,  color: '#14b8a6', icon: '⚕️' },
  { name: 'Seguros',           kind: 'gasto',   isFixed: true,  color: '#64748b', icon: '🛡️' },
  { name: 'Impuestos',         kind: 'gasto',   isFixed: true,  color: '#78716c', icon: '📄' },
  { name: 'Educación',         kind: 'gasto',   isFixed: true,  color: '#8b5cf6', icon: '🎓' },
  { name: 'Suscripciones',     kind: 'gasto',   isFixed: true,  color: '#a855f7', icon: '📺' },

  // Gastos variables
  { name: 'Supermercado',      kind: 'gasto',   isFixed: false, color: '#22c55e', icon: '🛒' },
  { name: 'Almacén y verdulería', kind: 'gasto',isFixed: false, color: '#84cc16', icon: '🥬' },
  { name: 'Café y kiosco',     kind: 'gasto',   isFixed: false, color: '#d97706', icon: '☕' },
  { name: 'Comer afuera',      kind: 'gasto',   isFixed: false, color: '#f59e0b', icon: '🍽️' },
  { name: 'Delivery',          kind: 'gasto',   isFixed: false, color: '#fb923c', icon: '🛵' },
  { name: 'Transporte',        kind: 'gasto',   isFixed: false, color: '#0ea5e9', icon: '🚌' },
  { name: 'Nafta',             kind: 'gasto',   isFixed: false, color: '#3b82f6', icon: '⛽' },
  { name: 'Salidas',           kind: 'gasto',   isFixed: false, color: '#ec4899', icon: '🎬' },
  { name: 'Ropa',              kind: 'gasto',   isFixed: false, color: '#d946ef', icon: '👕' },
  { name: 'Salud y farmacia',  kind: 'gasto',   isFixed: false, color: '#10b981', icon: '💊' },
  { name: 'Hogar',             kind: 'gasto',   isFixed: false, color: '#6366f1', icon: '🔧' },
  { name: 'Mascotas',          kind: 'gasto',   isFixed: false, color: '#f43f5e', icon: '🐾' },
  { name: 'Regalos',           kind: 'gasto',   isFixed: false, color: '#e11d48', icon: '🎁' },
  { name: 'Otros',             kind: 'gasto',   isFixed: false, color: '#94a3b8', icon: '•' },

  // Ingresos
  { name: 'Sueldo',            kind: 'ingreso', isFixed: false, color: '#16a34a', icon: '💼' },
  { name: 'Freelance',         kind: 'ingreso', isFixed: false, color: '#059669', icon: '💻' },
  { name: 'Ventas',            kind: 'ingreso', isFixed: false, color: '#65a30d', icon: '🏷️' },
  { name: 'Otros ingresos',    kind: 'ingreso', isFixed: false, color: '#94a3b8', icon: '•' },
];

const DEFAULT_ACCOUNTS: Array<{ name: string; type: string; currency: string; sortOrder: number }> = [
  { name: 'Efectivo',          type: 'efectivo',  currency: 'ARS', sortOrder: 1 },
  { name: 'Cuenta bancaria',   type: 'banco',     currency: 'ARS', sortOrder: 2 },
  { name: 'Tarjeta de crédito',type: 'tarjeta',   currency: 'ARS', sortOrder: 3 },
  { name: 'Ahorro en dólares', type: 'ahorro',    currency: 'USD', sortOrder: 4 },
];

/** Crea categorías y cuentas iniciales para un hogar recién nacido. */
export function seedHouseholdDefaults(householdId: string): void {
  db.insert(categories)
    .values(DEFAULT_CATEGORIES.map((c) => ({ householdId, ...c })))
    .run();

  db.insert(accounts)
    .values(DEFAULT_ACCOUNTS.map((a) => ({ householdId, ...a })))
    .run();
}

// ---------------------------------------------------------------------------
// Datos de demostración
// ---------------------------------------------------------------------------

/**
 * Genera un hogar de ejemplo con 4 meses de movimientos realistas.
 *
 * Existe para poder VER el detector de gasto hormiga funcionando sin esperar
 * tres meses cargando gastos. Incluye a propósito un par de patrones plantados:
 * un café diario, un kiosco, una suscripción con aumento de precio, y compras
 * mensuales de dólares.
 *
 * Correr con: npm run seed -- --demo
 */
async function seedDemo(): Promise<void> {
  const existing = sqlite.prepare(`SELECT id FROM users WHERE email = ?`).get('demo@hormiga.local');
  if (existing) {
    console.log('El hogar de demo ya existe. Borrá data/hormiga.db si querés regenerarlo.');
    return;
  }

  const household = db.insert(households).values({ name: 'Casa de demo' }).returning().all()[0];
  seedHouseholdDefaults(household.id);

  const passwordHash = await hashPassword('demo1234');
  const david = db.insert(users).values({
    householdId: household.id, email: 'demo@hormiga.local', passwordHash, displayName: 'Demo',
  }).returning().all()[0];

  const cats = db.select().from(categories).all()
    .filter((c) => c.householdId === household.id);
  const accs = db.select().from(accounts).all()
    .filter((a) => a.householdId === household.id);

  const catBy = (name: string) => cats.find((c) => c.name === name)!;
  const accBy = (name: string) => accs.find((a) => a.name === name)!;

  const merchantCache = new Map<string, string>();
  const merchant = (name: string): string => {
    const key = normalizeMerchantName(name);
    const cached = merchantCache.get(key);
    if (cached) return cached;
    const row = db.insert(merchants)
      .values({ householdId: household.id, name, normalizedName: key })
      .returning().all()[0];
    merchantCache.set(key, row.id);
    return row.id;
  };

  const today = new Date(`${todayISO()}T12:00:00Z`);
  const rows: Array<typeof transactions.$inferInsert> = [];

  // Cotización del blue simulada, subiendo suavemente mes a mes.
  const rateFor = (monthsAgo: number) => Math.round((1250 + (3 - monthsAgo) * 55) * 100);

  for (let monthsAgo = 3; monthsAgo >= 0; monthsAgo--) {
    const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsAgo, 1));
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const rate = rateFor(monthsAgo);
    const iso = (day: number) =>
      `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(day, daysInMonth)).padStart(2, '0')}`;

    const add = (
      type: 'gasto' | 'ingreso' | 'transferencia',
      day: number,
      amount: number,
      opts: Partial<typeof transactions.$inferInsert> = {},
    ) => {
      rows.push({
        householdId: household.id,
        type,
        date: iso(day),
        accountId: opts.accountId ?? accBy('Cuenta bancaria').id,
        amountMinor: Math.round(amount * 100),
        currency: 'ARS',
        usdRateMinor: rate,
        createdByUserId: david.id,
        paidByUserId: david.id,
        ...opts,
      });
    };

    const inflation = 1 + (3 - monthsAgo) * 0.06;

    // Ingresos
    add('ingreso', 3, 1_850_000 * inflation, { categoryId: catBy('Sueldo').id });
    add('ingreso', 5, 1_420_000 * inflation, { categoryId: catBy('Sueldo').id });

    // Gastos fijos
    add('gasto', 5,  620_000 * inflation, { categoryId: catBy('Alquiler').id, merchantId: merchant('Alquiler depto') });
    add('gasto', 8,  185_000 * inflation, { categoryId: catBy('Expensas').id, merchantId: merchant('Expensas') });
    add('gasto', 12,  96_000 * inflation, { categoryId: catBy('Luz, gas y agua').id, merchantId: merchant('Edesur') });
    add('gasto', 14,  78_000 * inflation, { categoryId: catBy('Internet y celular').id, merchantId: merchant('Fibertel') });
    add('gasto', 10, 310_000 * inflation, { categoryId: catBy('Prepaga').id, merchantId: merchant('OSDE') });

    // Suscripciones — Netflix aumenta todos los meses, que es justo lo que
    // el detector tiene que sacar a la luz.
    add('gasto', 17, 11_900 * (1 + (3 - monthsAgo) * 0.12), {
      categoryId: catBy('Suscripciones').id, merchantId: merchant('Netflix'),
      accountId: accBy('Tarjeta de crédito').id,
    });
    add('gasto', 22, 7_500 * inflation, {
      categoryId: catBy('Suscripciones').id, merchantId: merchant('Spotify'),
      accountId: accBy('Tarjeta de crédito').id,
    });

    // Supermercado: semanal, montos variables (NO debe salir como hormiga).
    for (const day of [6, 13, 20, 27]) {
      add('gasto', day, (95_000 + Math.random() * 45_000) * inflation, {
        categoryId: catBy('Supermercado').id, merchantId: merchant('Coto'),
      });
    }

    // EL GASTO HORMIGA. Café casi todos los días hábiles.
    for (let day = 1; day <= daysInMonth; day++) {
      const weekday = new Date(Date.UTC(year, month, day)).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      if (Math.random() > 0.8) continue;
      add('gasto', day, (2_600 + Math.random() * 700) * inflation, {
        categoryId: catBy('Café y kiosco').id, merchantId: merchant('Café de la esquina'),
        accountId: accBy('Efectivo').id,
      });
    }

    // Kiosco: menos frecuente pero igual de silencioso.
    for (let i = 0; i < 12; i++) {
      add('gasto', 1 + Math.floor(Math.random() * daysInMonth), (1_800 + Math.random() * 1_500) * inflation, {
        categoryId: catBy('Café y kiosco').id, merchantId: merchant('Kiosco Don Pepe'),
        accountId: accBy('Efectivo').id,
      });
    }

    // Delivery de los viernes.
    for (const day of [7, 14, 21, 28]) {
      if (Math.random() > 0.7) continue;
      add('gasto', day, (18_000 + Math.random() * 9_000) * inflation, {
        categoryId: catBy('Delivery').id, merchantId: merchant('PedidosYa'),
        accountId: accBy('Tarjeta de crédito').id,
      });
    }

    // Transporte diario.
    for (let i = 0; i < 18; i++) {
      add('gasto', 1 + Math.floor(Math.random() * daysInMonth), (1_100 + Math.random() * 400) * inflation, {
        categoryId: catBy('Transporte').id, merchantId: merchant('SUBE'),
        accountId: accBy('Efectivo').id,
      });
    }

    // Extracciones de efectivo. Sin esto la cuenta Efectivo queda en negativo,
    // porque el café y la SUBE salen de ahí y nunca entra nada. También sirve
    // para mostrar que una extracción es transferencia, no gasto: la plata
    // sigue siendo tuya, solo cambió de bolsillo.
    for (const day of [2, 16]) {
      rows.push({
        householdId: household.id,
        type: 'transferencia',
        date: iso(day),
        accountId: accBy('Cuenta bancaria').id,
        amountMinor: Math.round(70_000 * inflation) * 100,
        currency: 'ARS',
        toAccountId: accBy('Efectivo').id,
        amountToMinor: Math.round(70_000 * inflation) * 100,
        currencyTo: 'ARS',
        usdRateMinor: rate,
        note: 'Extracción de efectivo',
        createdByUserId: david.id,
      });
    }

    // Compra de dólares: transferencia ARS -> USD, jamás un gasto.
    const usd = 200 + monthsAgo * 25;
    rows.push({
      householdId: household.id,
      type: 'transferencia',
      date: iso(25),
      accountId: accBy('Cuenta bancaria').id,
      amountMinor: Math.round((usd * rate) / 100) * 100,
      currency: 'ARS',
      toAccountId: accBy('Ahorro en dólares').id,
      amountToMinor: usd * 100,
      currencyTo: 'USD',
      usdRateMinor: rate,
      note: 'Compra mensual de dólares',
      createdByUserId: david.id,
    });
  }

  // Lotes de 100: con ~20 columnas por fila son ~2.000 parámetros por insert,
  // bien por debajo del límite de variables de SQLite.
  for (let i = 0; i < rows.length; i += 100) {
    db.insert(transactions).values(rows.slice(i, i + 100)).run();
  }

  console.log(`Hogar de demo creado con ${rows.length} movimientos.`);
  console.log('  Entrá con: demo@hormiga.local / demo1234');
}

if (process.argv.includes('--demo')) {
  seedDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
