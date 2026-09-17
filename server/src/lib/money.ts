/**
 * Plata y fechas. Todo el resto del backend depende de que esto esté bien.
 */

/**
 * Convierte lo que el usuario escribe a unidades menores (enteros).
 *
 * Acepta las formas en que un argentino realmente tipea un monto:
 *   "1.234,56" -> 123456   (separador de miles punto, decimal coma)
 *   "1234,56"  -> 123456
 *   "1234.56"  -> 123456   (por si viene de un teclado numérico)
 *   "1234"     -> 123400
 *   "$ 1.234"  -> 123400
 *
 * La ambigüedad real es "1.234": ¿mil doscientos treinta y cuatro, o
 * 1,234? En es-AR el punto es miles, así que gana esa lectura.
 */
export function parseAmountToMinor(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Monto inválido');
    return Math.round(input * 100);
  }

  const cleaned = input.replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) throw new Error('Monto vacío');

  const negative = cleaned.startsWith('-');
  const body = cleaned.replace(/-/g, '');

  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');

  let normalized: string;
  if (lastComma === -1 && lastDot === -1) {
    normalized = body;
  } else if (lastComma > lastDot) {
    // La coma es el decimal: los puntos son separadores de miles.
    normalized = body.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    const decimals = body.length - lastDot - 1;
    if (decimals === 3 && lastComma === -1) {
      // "1.234" -> punto de miles, no decimal.
      normalized = body.replace(/\./g, '');
    } else {
      normalized = body.replace(/,/g, '');
    }
  } else {
    normalized = body;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) throw new Error(`Monto inválido: ${input}`);
  const minor = Math.round(value * 100);
  return negative ? -minor : minor;
}

export function formatMinor(minor: number, currency: 'ARS' | 'USD' = 'ARS'): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

/**
 * Normaliza el nombre de un comercio para poder agruparlo.
 * "Café Martínez ", "CAFE MARTINEZ" y "cafe  martinez" son el mismo lugar,
 * y si no los unificamos el detector de gasto hormiga no ve nada.
 */
export function normalizeMerchantName(name: string): string {
  return name
    .normalize('NFD')
    // NFD separa "é" en "e" + diacrítico combinante. Descartamos esos
    // combinantes (U+0300–U+036F) filtrando por code point en vez de con un
    // regex con escapes unicode, que es frágil según cómo se guarde el archivo.
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x0300 || code > 0x036f;
    })
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fecha de hoy en 'YYYY-MM-DD', hora local de Argentina. */
export function todayISO(timeZone = 'America/Argentina/Buenos_Aires'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** 'YYYY-MM-DD' -> 'YYYY-MM' */
export function periodOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Primer y último día de un período 'YYYY-MM'. */
export function periodRange(period: string): { start: string; end: string } {
  const [y, m] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    start: `${period}-01`,
    end: `${period}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** Corre `n` meses hacia atrás desde un período. shiftPeriod('2026-01', 1) -> '2025-12' */
export function shiftPeriod(period: string, monthsBack: number): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - monthsBack, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  return Math.round((db - da) / 86_400_000);
}

/**
 * Valúa un monto en USD usando la cotización congelada en la transacción.
 * Devuelve cents de USD, o null si no había cotización disponible.
 */
export function toUsdCents(
  amountMinor: number,
  currency: string,
  usdRateMinor: number | null | undefined,
): number | null {
  if (currency === 'USD') return amountMinor;
  if (!usdRateMinor || usdRateMinor <= 0) return null;
  // amountMinor son centavos ARS; usdRateMinor son centavos ARS por 1 USD.
  return Math.round((amountMinor / usdRateMinor) * 100);
}
