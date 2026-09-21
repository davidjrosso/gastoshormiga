import { parseAmountToMinor } from '../lib/money.js';
import type { HolderTotal, LineKind, ParsedStatement, StatementLine } from './types.js';

/**
 * Parser del resumen de tarjeta de BBVA Argentina (Visa).
 *
 * Trabaja sobre el TEXTO ya extraído del PDF, no sobre el PDF. Esa separación
 * es a propósito: la extracción depende de dónde corra (navegador o server) y
 * de qué librería haya, mientras que esto —que es lo que de verdad hay que
 * acertar— queda puro y testeable sin ninguna dependencia.
 *
 * Todo lo de acá es específico de BBVA. Para sumar otro banco se escribe otro
 * archivo como éste que devuelva el mismo `ParsedStatement`.
 */

/** Monedas que sabemos leer en un consumo del exterior. */
const MONEDAS = new Set(['USD', 'UYU', 'EUR', 'BRL', 'CLP', 'PYG', 'BOB', 'PEN', 'MXN', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'COP']);

/** Compara nombres de titular: el resumen los escribe en mayúsculas en los
 *  totales y en capitalizado en los encabezados de sección. */
const mismoTitular = (a: string, b: string) =>
  a.toUpperCase().replace(/\s+/g, ' ').trim() === b.toUpperCase().replace(/\s+/g, ' ').trim();

const MESES: Record<string, string> = {
  ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
  jul: '07', ago: '08', sep: '09', set: '09', oct: '10', nov: '11', dic: '12',
};

/** '27-Ago-26' -> '2026-08-27'. Devuelve null si no es una fecha del resumen. */
export function parseFecha(s: string): string | null {
  const m = /^(\d{2})-([A-Za-zÁ-úñÑ]{3})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const mes = MESES[m[2].toLowerCase()];
  if (!mes) return null;
  return `20${m[3]}-${mes}-${m[1]}`;
}

/**
 * Todos los importes "sueltos" de un renglón, en orden.
 *
 * Descarta los que están pegados a un `%`, porque un "3,00%" tiene forma de
 * importe y no lo es. Sin esa exclusión, la alícuota de IIBB se confunde con
 * la base y el renglón entra con el monto equivocado.
 */
function importes(texto: string): string[] {
  const out: string[] = [];
  const re = /(?<![\d.,])(-?[\d.]*\d,\d{2})(?!\s*%)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) out.push(m[1]);
  return out;
}

const CAB_PAGOS = /Sus pagos y ajustes realizados/i;
const CAB_CONSUMOS = /^Consumos\s+(.+?)\s*$/i;
const CAB_TOTAL = /^TOTAL CONSUMOS DE\s+(.+?)\s+(-?[\d.]*\d,\d{2})\s+(-?[\d.]*\d,\d{2})\s*$/i;
const CAB_IMPUESTOS = /Impuestos,\s*cargos e intereses/i;
const FIN = /^(Legales y avisos|SALDO ACTUAL\s)/i;
const RUIDO = /^(FECHA\s+DESCRIPCIÓN|Sobre \(|Banco BBVA|DETALLE$|@@@)/i;

/** Clasifica un renglón de la sección de impuestos, cargos e intereses. */
function clasificarCargo(desc: string): LineKind {
  const d = desc.toUpperCase();
  // La RG 5617 va primero: es la única que vuelve, y confundirla con un
  // impuesto común es el error que hace que el mes figure peor de lo que fue.
  if (/RG\s*5617/.test(d)) return d.startsWith('CR') ? 'credito_percepcion' : 'percepcion_recuperable';
  if (/INTERES/.test(d)) return 'interes';
  if (/ADELANTO/.test(d)) return 'adelanto';
  if (/SELLOS|IIBB|IVA|PERCEP|IMPUESTO/.test(d)) return 'impuesto';
  return 'desconocido';
}

/** Parsea un renglón de consumo: fecha, comercio, cuota, moneda origen, cupón, importe. */
function parseConsumo(fecha: string, resto: string, holder: string): StatementLine | null {
  let t = resto.trimEnd();

  // Se lee de derecha a izquierda porque la descripción es lo único de largo
  // variable: el importe, el cupón y la cuota tienen forma fija y se pueden
  // ir recortando con seguridad desde el final.
  const mImporte = /(-?[\d.]*\d,\d{2})\s*$/.exec(t);
  if (!mImporte) return null;
  const importe = mImporte[1];
  t = t.slice(0, mImporte.index).trimEnd();

  let coupon: string | null = null;
  const mCupon = /(?:^|\s)(\d{6})\s*$/.exec(t);
  if (mCupon) { coupon = mCupon[1]; t = t.slice(0, mCupon.index).trimEnd(); }

  let installment: { n: number; of: number } | null = null;
  const mCuota = /\s+C\.(\d{1,2})\/(\d{1,2})\s*$/.exec(t);
  if (mCuota) {
    installment = { n: Number(mCuota[1]), of: Number(mCuota[2]) };
    t = t.slice(0, mCuota.index).trimEnd();
  }

  // Compra en el exterior: el resumen muestra la moneda y el monto originales
  // y factura en USD. Guardamos los dos: sin el original no se puede auditar
  // a qué tipo de cambio te la liquidaron.
  //
  // El código de moneda NO exige un espacio delante a propósito. El PDF usa
  // columnas de ancho fijo y cuando la descripción se pasa de largo, la moneda
  // queda pegada al texto ("NETFLIX.COM Jhymf4UPaUSD 13,49"). Exigiendo el
  // espacio, esos renglones se cuelan como pesos: el importe es correcto pero
  // la moneda no, y el mes cierra con la diferencia justa entre las dos
  // columnas. Por eso también la lista blanca: una moneda que no conocemos
  // entra como pesos y la verificación final lo grita, que es el modo de
  // fallar correcto.
  let original: { code: string; amount: number } | null = null;
  const mOrig = /([A-Z]{3})\s+([\d.]*\d,\d{2})\s*$/.exec(t);
  if (mOrig && MONEDAS.has(mOrig[1])) {
    original = { code: mOrig[1], amount: parseAmountToMinor(mOrig[2]) / 100 };
    t = t.slice(0, mOrig.index).trimEnd();
  }

  return {
    kind: 'consumo',
    holder,
    date: fecha,
    description: t.replace(/\s{2,}/g, ' ').trim(),
    coupon,
    amountMinor: parseAmountToMinor(importe),
    // Si el renglón trae moneda de origen, se liquidó en dólares.
    currency: original ? 'USD' : 'ARS',
    installment,
    original,
    taxBaseMinor: null,
  };
}

export function parseBbvaVisa(texto: string): ParsedStatement {
  const lineas = texto.split('\n').map((l) => l.replace(/\s+$/, ''));

  const uno = (re: RegExp): string | null => {
    const m = re.exec(texto);
    return m ? m[1] : null;
  };
  const minor = (s: string | null): number => (s ? parseAmountToMinor(s) : 0);

  const card = uno(/\n(Visa [A-Za-zÁ-úñÑ]+)\s+cuenta/) ?? 'Visa';
  const cuenta = uno(/cuenta\s+(\d{6,})/);

  const cierre = parseFecha(uno(/CIERRE ACTUAL\s*(\d{2}-[A-Za-zÁ-úñÑ]{3}-\d{2})/) ?? '') ?? '';
  const vto = parseFecha(uno(/VENCIMIENTO ACTUAL\s*(\d{2}-[A-Za-zÁ-úñÑ]{3}-\d{2})/) ?? '') ?? '';
  const mAnterior = /SALDO ANTERIOR\s+(-?[\d.]*\d,\d{2})\s+(-?[\d.]*\d,\d{2})/.exec(texto);

  const lines: StatementLine[] = [];
  const holders: HolderTotal[] = [];
  let seccion: 'ninguna' | 'pagos' | 'consumos' | 'cargos' = 'ninguna';
  let holderActual = '';

  for (const raw of lineas) {
    const l = raw.trim();
    if (!l || RUIDO.test(l)) continue;

    if (CAB_PAGOS.test(l)) { seccion = 'pagos'; continue; }
    if (CAB_IMPUESTOS.test(l)) { seccion = 'cargos'; continue; }
    const mCons = CAB_CONSUMOS.exec(l);
    if (mCons) { seccion = 'consumos'; holderActual = mCons[1].trim(); continue; }
    const mTot = seccion === 'consumos' ? CAB_TOTAL.exec(l) : null;
    if (mTot) {
      holders.push({
        holder: mTot[1].trim(),
        statedArsMinor: parseAmountToMinor(mTot[2]),
        statedUsdCents: parseAmountToMinor(mTot[3]),
      });
      continue;
    }
    if (FIN.test(l)) { if (seccion === 'cargos') seccion = 'ninguna'; continue; }

    const mFecha = /^(\d{2}-[A-Za-zÁ-úñÑ]{3}-\d{2})\s+(.*)$/.exec(l);
    if (!mFecha) continue;
    const fecha = parseFecha(mFecha[1]);
    if (!fecha) continue;
    const resto = mFecha[2];

    if (seccion === 'consumos') {
      const c = parseConsumo(fecha, resto, holderActual);
      if (c) lines.push(c);
      continue;
    }

    if (seccion === 'pagos' || seccion === 'cargos') {
      const nums = importes(resto);
      if (nums.length === 0) continue;
      // El último importe es el cargo. Si hay otro antes, es la base
      // imponible: así viene "DB IVA $ 21%  72.377,45  15.199,26", donde el
      // primero es la base y el segundo el impuesto. Tomar el primero sería
      // cobrar 72.377 de IVA en vez de 15.199.
      const importe = nums[nums.length - 1];
      const base = nums.length > 1 ? nums[nums.length - 2] : null;
      const desc = resto
        .slice(0, resto.lastIndexOf(importe))
        .replace(/\(\s*[\d.]*\d[.,]\d{2}\s*\)?\s*$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

      const esPago = /SU PAGO/i.test(desc);
      const kind: LineKind = seccion === 'pagos'
        ? (esPago ? 'pago' : clasificarCargo(desc))
        : clasificarCargo(desc);

      lines.push({
        kind,
        holder: null,
        date: fecha,
        description: desc,
        coupon: null,
        amountMinor: parseAmountToMinor(importe),
        currency: /USD|U\$S/i.test(desc) ? 'USD' : 'ARS',
        installment: null,
        original: null,
        taxBaseMinor: base ? parseAmountToMinor(base) : null,
      });
    }
  }

  // --- Verificación aritmética -------------------------------------------
  // Un parser de PDF no falla con una excepción: falla perdiendo un renglón y
  // devolviendo un número que parece razonable. La única defensa es sumar lo
  // parseado y compararlo contra los totales que el propio resumen declara.
  const balanceArs = minor(uno(/SALDO ACTUAL \$\s*(-?[\d.]*\d,\d{2})/));
  const balanceUsd = minor(uno(/SALDO ACTUAL U\$S\s*(-?[\d.]*\d,\d{2})/));
  const previousArs = mAnterior ? parseAmountToMinor(mAnterior[1]) : 0;
  const previousUsd = mAnterior ? parseAmountToMinor(mAnterior[2]) : 0;

  const suma = (cur: 'ARS' | 'USD') =>
    lines.filter((l) => l.currency === cur).reduce((s, l) => s + l.amountMinor, 0);

  const computedArs = previousArs + suma('ARS');
  const computedUsd = previousUsd + suma('USD');

  const byHolder = holders.map((h) => {
    const suyas = lines.filter((l) => l.holder && mismoTitular(l.holder, h.holder));
    const ars = suyas.filter((l) => l.currency === 'ARS').reduce((s, l) => s + l.amountMinor, 0);
    const usd = suyas.filter((l) => l.currency === 'USD').reduce((s, l) => s + l.amountMinor, 0);
    return {
      holder: h.holder,
      diffArsMinor: ars - h.statedArsMinor,
      diffUsdCents: usd - h.statedUsdCents,
    };
  });

  const diffArs = computedArs - balanceArs;
  const diffUsd = computedUsd - balanceUsd;

  return {
    bank: 'bbva',
    card,
    accountTail: cuenta ? cuenta.slice(-4) : null,
    closeDate: cierre,
    dueDate: vto,
    balanceArsMinor: balanceArs,
    balanceUsdCents: balanceUsd,
    minimumArsMinor: minor(uno(/PAGO MÍNIMO \$\s*(-?[\d.]*\d,\d{2})/)),
    previousArsMinor: previousArs,
    previousUsdCents: previousUsd,
    holders,
    lines,
    check: {
      ok: diffArs === 0 && diffUsd === 0 && byHolder.every((h) => h.diffArsMinor === 0 && h.diffUsdCents === 0),
      computedArsMinor: computedArs,
      computedUsdCents: computedUsd,
      diffArsMinor: diffArs,
      diffUsdCents: diffUsd,
      byHolder,
    },
  };
}
