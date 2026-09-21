import { and, eq, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../auth.js';
import { db } from '../db/index.js';
import { accounts, cardHolders, categories, merchants, statementImports, transactions } from '../db/schema.js';
import { getRateForDate, householdRateType } from '../fx/rates.js';
import { parseBbvaVisa } from '../import/bbva-visa.js';
import { planImport, type PlanContext } from '../import/plan.js';
import { normalizeMerchantName } from '../lib/money.js';

export const importRoutes = new Hono<AppEnv>();
importRoutes.use('*', requireAuth);

const PARSERS = { bbva: parseBbvaVisa };
type Banco = keyof typeof PARSERS;

const bodySchema = z.object({
  bank: z.enum(['bbva']).default('bbva'),
  /** Texto ya extraído del PDF. Se extrae en el navegador: el resumen no
   *  necesita salir de la máquina del usuario para esto. */
  text: z.string().min(50, 'El texto del resumen está vacío o es demasiado corto'),
  accountId: z.string(),
  paymentAccountId: z.string().nullable().optional(),
  advanceAccountId: z.string().nullable().optional(),
});

/** Cuenta propia del hogar, o null. Nunca confiar en un id que llega de afuera. */
function cuentaDelHogar(householdId: string, id: string | null | undefined) {
  if (!id) return null;
  const r = db.select().from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.householdId, householdId))).limit(1).all();
  return r[0] ?? null;
}

/** Busca una categoría por nombre, o la crea. */
function categoria(householdId: string, name: string, icon: string, color: string): string {
  const existe = db.select().from(categories)
    .where(and(eq(categories.householdId, householdId), eq(categories.name, name))).limit(1).all();
  if (existe.length) return existe[0].id;
  return db.insert(categories)
    .values({ householdId, name, kind: 'gasto', isFixed: false, icon, color })
    .returning().all()[0].id;
}

/**
 * La cuenta donde esperan las percepciones que ARCA devuelve.
 *
 * Se crea sola la primera vez. Es del tipo `ahorro` porque el saldo es plata
 * del hogar, igual que los dólares guardados: no se gastó, solo está en otro
 * lado. Lo que no puede ser es un gasto.
 */
function cuentaPercepciones(householdId: string): string {
  const NOMBRE = 'Percepciones a recuperar';
  const existe = db.select().from(accounts)
    .where(and(eq(accounts.householdId, householdId), eq(accounts.name, NOMBRE))).limit(1).all();
  if (existe.length) return existe[0].id;
  return db.insert(accounts)
    .values({ householdId, name: NOMBRE, type: 'ahorro', currency: 'ARS', sortOrder: 90 })
    .returning().all()[0].id;
}

function contexto(householdId: string, b: z.infer<typeof bodySchema>, cardAccountId: string): PlanContext {
  const defaults = new Map<string, string | null>();
  for (const m of db.select().from(merchants).where(eq(merchants.householdId, householdId)).all()) {
    defaults.set(m.normalizedName, m.defaultCategoryId);
  }

  const usadas = db.select({ fp: transactions.importFingerprint }).from(transactions)
    .where(and(eq(transactions.householdId, householdId), isNotNull(transactions.importFingerprint))).all();

  return {
    cardAccountId,
    percepcionesAccountId: cuentaPercepciones(householdId),
    paymentAccountId: cuentaDelHogar(householdId, b.paymentAccountId)?.id ?? null,
    advanceAccountId: cuentaDelHogar(householdId, b.advanceAccountId)?.id ?? null,
    categoryIds: {
      impuestos: categoria(householdId, 'Impuestos y percepciones', '🧾', '#78716c'),
      intereses: categoria(householdId, 'Intereses y comisiones', '🏦', '#b45309'),
    },
    existing: new Set(usadas.map((u) => u.fp!).filter(Boolean)),
    merchantDefaults: defaults,
  };
}

function armarPlan(householdId: string, b: z.infer<typeof bodySchema>) {
  const card = cuentaDelHogar(householdId, b.accountId);
  if (!card) return { error: 'La cuenta de la tarjeta no existe en este hogar' } as const;
  const st = PARSERS[b.bank as Banco](b.text);
  if (!st.closeDate) return { error: 'No se reconoció el resumen: falta la fecha de cierre' } as const;
  return { plan: planImport(st, contexto(householdId, b, card.id)), card } as const;
}

/**
 * Previsualización. NO escribe nada.
 *
 * Existe porque importar 85 renglones a ciegas es la forma más rápida de
 * ensuciar una base que después nadie limpia. Primero se mira, después se
 * confirma.
 */
importRoutes.post('/preview', async (c) => {
  const user = c.get('user');
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);

  const r = armarPlan(user.householdId, parsed.data);
  if ('error' in r) return c.json({ error: r.error }, 400);
  return c.json(r.plan);
});

importRoutes.post('/confirm', async (c) => {
  const user = c.get('user');
  const parsed = bodySchema.extend({
    /** Qué renglones importar. Si no viene, entran todos los nuevos. */
    only: z.array(z.string()).optional(),
  }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);

  const r = armarPlan(user.householdId, parsed.data);
  if ('error' in r) return c.json({ error: r.error }, 400);
  const { plan, card } = r;

  // Si la aritmética del resumen no cierra, algo se perdió al parsear y no
  // sabemos qué. Importar igual sería meter en la base números que ya sabemos
  // que están mal.
  if (!plan.statement.check.ok) {
    return c.json({
      error: 'El resumen no cierra contra sus propios totales. No se importó nada.',
      check: plan.statement.check,
    }, 422);
  }

  const elegidos = parsed.data.only ? new Set(parsed.data.only) : null;
  const aImportar = plan.movements.filter(
    (m) => m.status === 'nuevo' && m.movement && (!elegidos || elegidos.has(m.fingerprint)),
  );

  const rateType = householdRateType(user.householdId);
  let creados = 0;

  // Todo o nada: una importación a medias es peor que ninguna, porque deja
  // una base en un estado que nadie sabe reconstruir.
  db.transaction((tx) => {
    const imp = tx.insert(statementImports).values({
      householdId: user.householdId,
      accountId: card.id,
      bank: plan.statement.bank,
      card: plan.statement.card,
      closeDate: plan.statement.closeDate,
      dueDate: plan.statement.dueDate,
      balanceMinor: plan.statement.balanceArsMinor,
      balanceUsd: plan.statement.balanceUsdCents,
      linesTotal: plan.movements.length,
      linesImported: aImportar.length,
      createdByUserId: user.id,
    }).returning().all()[0];

    /** Titular del resumen: se da de alta solo la primera vez. */
    const holderId = (nombre: string | null): string | null => {
      if (!nombre) return null;
      const norm = normalizeMerchantName(nombre);
      const hay = tx.select().from(cardHolders)
        .where(and(eq(cardHolders.accountId, card.id), eq(cardHolders.normalizedName, norm)))
        .limit(1).all();
      if (hay.length) return hay[0].id;
      return tx.insert(cardHolders).values({
        householdId: user.householdId, accountId: card.id, name: nombre.trim(), normalizedName: norm,
      }).returning().all()[0].id;
    };

    const merchantId = (nombre: string | null): string | null => {
      if (!nombre?.trim()) return null;
      const norm = normalizeMerchantName(nombre);
      if (!norm) return null;
      const hay = tx.select().from(merchants)
        .where(and(eq(merchants.householdId, user.householdId), eq(merchants.normalizedName, norm)))
        .limit(1).all();
      if (hay.length) return hay[0].id;
      return tx.insert(merchants).values({
        householdId: user.householdId, name: nombre.trim(), normalizedName: norm,
      }).returning().all()[0].id;
    };

    for (const m of aImportar) {
      const mv = m.movement!;
      tx.insert(transactions).values({
        householdId: user.householdId,
        type: mv.type,
        date: mv.date,
        accountId: mv.accountId,
        amountMinor: mv.amountMinor,
        currency: mv.currency,
        toAccountId: mv.toAccountId,
        amountToMinor: mv.toAccountId ? mv.amountMinor : null,
        currencyTo: mv.toAccountId ? mv.currency : null,
        categoryId: mv.categoryId,
        merchantId: merchantId(mv.merchantName),
        note: mv.note || null,
        cardHolderId: holderId(mv.holder),
        installmentN: mv.installment?.n ?? null,
        installmentOf: mv.installment?.of ?? null,
        originalCurrency: mv.original?.code ?? null,
        originalAmountMinor: mv.original ? Math.round(mv.original.amount * 100) : null,
        statementImportId: imp.id,
        importFingerprint: m.fingerprint,
        createdByUserId: user.id,
        usdRateMinor: getRateForDate(rateType, mv.date),
      }).run();
      creados++;
    }
  });

  return c.json({ importados: creados, cierre: plan.statement.closeDate, resumen: plan.summary }, 201);
});

/** Historial de resúmenes importados. */
importRoutes.get('/', (c) => {
  const user = c.get('user');
  return c.json(
    db.select().from(statementImports)
      .where(eq(statementImports.householdId, user.householdId))
      .orderBy(statementImports.closeDate).all(),
  );
});
