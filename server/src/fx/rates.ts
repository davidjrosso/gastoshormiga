import { and, desc, eq, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { fxRates, households } from '../db/schema.js';
import { todayISO } from '../lib/money.js';

/**
 * Cotizaciones del dólar.
 *
 * Fuente: dolarapi.com, pública y sin API key. El server hace un GET saliente
 * y no manda ningún dato del hogar: solo pide el precio del día.
 *
 * Por qué importa tanto acá: con inflación de tres dígitos, comparar el gasto
 * de septiembre contra el de marzo en pesos nominales no dice nada. Guardando
 * la cotización de cada día podemos expresar cualquier gasto pasado en USD
 * del momento en que ocurrió, que es la única vara estable que tenemos.
 */

export type RateType = 'blue' | 'oficial' | 'mep' | 'cripto';

/**
 * Qué cotización usa este hogar para valuar en USD.
 *
 * Vive acá y no en una ruta porque lo necesita todo lo que congela un tipo de
 * cambio: la carga manual de un movimiento y la materialización de los gastos
 * fijos. Tenerlo duplicado fue exactamente lo que dejó a los fijos valuados en
 * blue aunque el hogar tuviera configurado "oficial" en Ajustes.
 */
export function householdRateType(householdId: string): RateType {
  const row = db
    .select({ fxRateType: households.fxRateType })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1)
    .all();
  return (row[0]?.fxRateType ?? 'blue') as RateType;
}

const ENDPOINTS: Record<RateType, string> = {
  blue: 'https://dolarapi.com/v1/dolares/blue',
  oficial: 'https://dolarapi.com/v1/dolares/oficial',
  mep: 'https://dolarapi.com/v1/dolares/bolsa',
  cripto: 'https://dolarapi.com/v1/dolares/cripto',
};

interface DolarApiResponse {
  compra: number;
  venta: number;
  fechaActualizacion: string;
}

export function upsertRate(
  date: string,
  type: RateType,
  buyMinor: number,
  sellMinor: number,
  source = 'dolarapi',
): void {
  db.insert(fxRates)
    .values({ date, type, buyMinor, sellMinor, source, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: [fxRates.date, fxRates.type],
      set: { buyMinor, sellMinor, source, fetchedAt: new Date() },
    })
    .run();
}

/** Trae una cotización de la API pública y la guarda. Devuelve null si falla. */
export async function fetchRate(type: RateType): Promise<{ buyMinor: number; sellMinor: number } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(ENDPOINTS[type], { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[fx] ${type}: HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as DolarApiResponse;
    if (typeof data.venta !== 'number' || data.venta <= 0) {
      console.warn(`[fx] ${type}: respuesta sin cotización válida`);
      return null;
    }

    const buyMinor = Math.round((data.compra ?? data.venta) * 100);
    const sellMinor = Math.round(data.venta * 100);
    upsertRate(todayISO(), type, buyMinor, sellMinor);
    return { buyMinor, sellMinor };
  } catch (err) {
    // Sin internet la app tiene que seguir andando: se usa la última
    // cotización conocida. Nunca tirar abajo una carga de gasto por esto.
    console.warn(`[fx] no se pudo actualizar ${type}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Cotización vigente para una fecha: la más reciente que sea <= esa fecha.
 * Si la fecha es anterior a todo lo que tenemos (por ejemplo cargás un gasto
 * viejo), cae en la más antigua disponible, que es mejor que nada.
 */
export function getRateForDate(type: RateType, date: string): number | null {
  const atOrBefore = db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.type, type), lte(fxRates.date, date)))
    .orderBy(desc(fxRates.date))
    .limit(1)
    .all();

  if (atOrBefore.length > 0) return atOrBefore[0].sellMinor;

  const anyRate = db
    .select()
    .from(fxRates)
    .where(eq(fxRates.type, type))
    .orderBy(fxRates.date)
    .limit(1)
    .all();

  return anyRate.length > 0 ? anyRate[0].sellMinor : null;
}

export function getLatestRates(): Array<{ type: string; buyMinor: number; sellMinor: number; date: string }> {
  const rows = db.select().from(fxRates).orderBy(desc(fxRates.date)).all();
  const seen = new Set<string>();
  const out: Array<{ type: string; buyMinor: number; sellMinor: number; date: string }> = [];
  for (const r of rows) {
    if (seen.has(r.type)) continue;
    seen.add(r.type);
    out.push({ type: r.type, buyMinor: r.buyMinor, sellMinor: r.sellMinor, date: r.date });
  }
  return out;
}

/** Refresca todas las cotizaciones. Se llama al arrancar y una vez por día. */
export async function refreshAllRates(): Promise<void> {
  const types: RateType[] = ['blue', 'oficial', 'mep'];
  await Promise.all(types.map((t) => fetchRate(t)));
}

/**
 * Arranca el refresco periódico. Cada 6 horas alcanza: el blue no se mueve
 * tanto como para justificar más, y no queremos martillar una API gratuita.
 */
export function startRateScheduler(): void {
  void refreshAllRates();
  setInterval(() => void refreshAllRates(), 6 * 60 * 60 * 1000).unref();
}
