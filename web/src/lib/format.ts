/** Formateo. Todo lo que el usuario lee de plata pasa por acá. */

export function money(minor: number, currency: 'ARS' | 'USD' = 'ARS', decimals = true): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  }).format(minor / 100);
}

/**
 * Versión corta para los números grandes del dashboard.
 * Con pesos argentinos, "$2.349.203" ocupa media pantalla en un celular;
 * "$2,3 M" se lee de un vistazo, que es lo que uno hace con un total.
 */
export function moneyShort(minor: number, currency: 'ARS' | 'USD' = 'ARS'): string {
  const value = minor / 100;
  const abs = Math.abs(value);
  const symbol = currency === 'USD' ? 'US$' : '$';
  const sign = value < 0 ? '-' : '';

  if (abs >= 1_000_000) {
    return `${sign}${symbol} ${(abs / 1_000_000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} M`;
  }
  if (abs >= 10_000) {
    return `${sign}${symbol} ${(abs / 1000).toLocaleString('es-AR', { maximumFractionDigits: 0 })} mil`;
  }
  return `${sign}${symbol} ${abs.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
}

/**
 * Monto listo para meter en un input de edición.
 *
 * Sin separador de miles a propósito: "3.000" vuelve a entrar por
 * `parseAmountToMinor`, que tiene que decidir si el punto es miles o decimal.
 * Es una ambigüedad que no hace falta crear cuando somos nosotros los que
 * escribimos el valor. Sin puntos, la vuelta es exacta siempre.
 */
export function amountForInput(minor: number): string {
  const abs = Math.abs(minor);
  const entero = Math.trunc(abs / 100);
  const centavos = abs % 100;
  return centavos === 0 ? String(entero) : `${entero},${String(centavos).padStart(2, '0')}`;
}

export function pct(value: number | null | undefined, withSign = false): string {
  if (value == null) return '—';
  const sign = withSign && value > 0 ? '+' : '';
  return `${sign}${value.toLocaleString('es-AR', { maximumFractionDigits: 1 })}%`;
}

const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** '2026-09' -> 'septiembre 2026' */
export function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** '2026-09-16' -> 'mar 16 sep' */
export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return new Intl.DateTimeFormat('es-AR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(d);
}

export function todayISO(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function currentPeriod(): string {
  return todayISO().slice(0, 7);
}

export function shiftPeriod(period: string, monthsBack: number): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - monthsBack, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
