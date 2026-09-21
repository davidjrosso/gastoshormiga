import { createHash } from 'node:crypto';
import { normalizeMerchantName } from '../lib/money.js';
import type { ParsedStatement, StatementLine } from './types.js';

/**
 * Convierte los renglones de un resumen en movimientos de la app.
 *
 * Acá vive la decisión que hace que el importador sirva o arruine el mes: un
 * resumen de tarjeta NO es una lista de gastos. Trae mezclados el pago del mes
 * anterior, consumos nuevos, cuotas de compras viejas, intereses, adelantos e
 * impuestos, y cada uno entra distinto.
 *
 * Es una función pura: recibe el resumen y el contexto ya resuelto, y devuelve
 * lo que HARÍA. No escribe nada. Eso es lo que permite mostrar una pantalla de
 * revisión antes de confirmar, que es la única forma honesta de importar 85
 * renglones de una.
 */

export interface PlanContext {
  /** La cuenta de la tarjeta. Todo lo del resumen pasa por acá. */
  cardAccountId: string;
  /** Dónde esperan las percepciones que ARCA devuelve el mes siguiente. */
  percepcionesAccountId: string;
  /** De qué cuenta salió el pago del resumen. Sin esto, los pagos no entran. */
  paymentAccountId: string | null;
  /** A qué cuenta fue a parar un adelanto. Sin esto, no entra. */
  advanceAccountId: string | null;
  categoryIds: { impuestos: string | null; intereses: string | null };
  /** Huellas ya presentes en la base. Lo que hace idempotente reimportar. */
  existing: Set<string>;
  /** Categoría por defecto de cada comercio ya conocido, por nombre
   *  normalizado. Es lo que evita reclasificar 85 renglones todos los meses. */
  merchantDefaults: Map<string, string | null>;
}

export type PlanStatus = 'nuevo' | 'ya_importado' | 'ignorado';

export interface PlannedMovement {
  fingerprint: string;
  status: PlanStatus;
  /** Por qué se ignora. Siempre se dice: nada se descarta en silencio. */
  reason: string | null;
  line: StatementLine;
  movement: {
    type: 'gasto' | 'ingreso' | 'transferencia';
    date: string;
    amountMinor: number;
    currency: 'ARS' | 'USD';
    accountId: string;
    toAccountId: string | null;
    categoryId: string | null;
    merchantName: string | null;
    holder: string | null;
    note: string;
    installment: { n: number; of: number } | null;
    original: { code: string; amount: number } | null;
  } | null;
}

export interface ImportPlan {
  statement: ParsedStatement;
  movements: PlannedMovement[];
  summary: {
    nuevos: number;
    yaImportados: number;
    ignorados: number;
    /** Lo que va a sumar como gasto del período. NO incluye pagos,
     *  adelantos ni la percepción recuperable: ninguno de los tres es gasto. */
    gastoNuevoMinor: number;
    gastoNuevoUsdCents: number;
    /** Lo que queda inmovilizado esperando que ARCA lo devuelva. */
    percepcionRecuperableMinor: number;
  };
}

/**
 * Huella estable de un renglón.
 *
 * Incluye la fecha de cierre del resumen a propósito. Una cuota aparece en
 * varios resúmenes seguidos con el mismo cupón y el mismo importe, y son
 * cargos distintos y legítimos: sin el cierre, la cuota 4/6 se confundiría
 * con la 3/6 y el importador se comería una.
 */
export function fingerprint(closeDate: string, accountId: string, l: StatementLine): string {
  const partes = [
    accountId,
    closeDate,
    l.kind,
    l.date,
    l.holder ?? '',
    l.coupon ?? normalizeMerchantName(l.description),
    String(l.amountMinor),
    l.currency,
    l.installment ? `${l.installment.n}/${l.installment.of}` : '',
  ];
  return createHash('sha1').update(partes.join('|')).digest('hex');
}

export function planImport(st: ParsedStatement, ctx: PlanContext): ImportPlan {
  const movements: PlannedMovement[] = [];

  for (const line of st.lines) {
    const fp = fingerprint(st.closeDate, ctx.cardAccountId, line);
    const yaEsta = ctx.existing.has(fp);

    const ignorar = (reason: string): PlannedMovement =>
      ({ fingerprint: fp, status: yaEsta ? 'ya_importado' : 'ignorado', reason, line, movement: null });

    let mv: PlannedMovement['movement'] = null;
    let reason: string | null = null;

    switch (line.kind) {
      case 'consumo': {
        const norm = normalizeMerchantName(line.description);
        mv = {
          type: 'gasto',
          date: line.date,
          amountMinor: line.amountMinor,
          currency: line.currency,
          accountId: ctx.cardAccountId,
          toAccountId: null,
          categoryId: ctx.merchantDefaults.get(norm) ?? null,
          merchantName: line.description,
          holder: line.holder,
          note: line.installment ? `Cuota ${line.installment.n}/${line.installment.of}` : '',
          installment: line.installment,
          original: line.original,
        };
        break;
      }

      case 'pago': {
        // Pagar la tarjeta cancela una deuda: la plata se mueve del banco a la
        // tarjeta, no sale del hogar. Contarlo como gasto duplicaría todo el
        // consumo del mes anterior, que ya se contó cuando se hizo.
        if (!ctx.paymentAccountId) {
          movements.push(ignorar('Falta indicar de qué cuenta salió el pago'));
          continue;
        }
        mv = {
          type: 'transferencia',
          date: line.date,
          amountMinor: Math.abs(line.amountMinor),
          currency: line.currency,
          accountId: ctx.paymentAccountId,
          toAccountId: ctx.cardAccountId,
          categoryId: null,
          merchantName: null,
          holder: null,
          note: line.description,
          installment: null,
          original: null,
        };
        break;
      }

      case 'adelanto': {
        // Un adelanto tampoco es gasto: sacaste plata de la tarjeta y la
        // pusiste en otro lado. El gasto vendrá después, cuando la uses.
        if (!ctx.advanceAccountId) {
          movements.push(ignorar('Falta indicar a qué cuenta fue el adelanto'));
          continue;
        }
        mv = {
          type: 'transferencia',
          date: line.date,
          amountMinor: Math.abs(line.amountMinor),
          currency: line.currency,
          accountId: ctx.cardAccountId,
          toAccountId: ctx.advanceAccountId,
          categoryId: null,
          merchantName: null,
          holder: null,
          note: line.description,
          installment: null,
          original: null,
        };
        break;
      }

      case 'percepcion_recuperable': {
        // El 30% de la RG 5617 vuelve en el resumen siguiente si pagás el
        // saldo en dólares. No es un gasto: es plata tuya en manos de ARCA por
        // 30 días. Cargarla como gasto hace que el mes figure peor de lo que
        // fue, y que al mes siguiente aparezca un ingreso fantasma.
        mv = {
          type: 'transferencia',
          date: line.date,
          amountMinor: Math.abs(line.amountMinor),
          currency: line.currency,
          accountId: ctx.cardAccountId,
          toAccountId: ctx.percepcionesAccountId,
          categoryId: null,
          merchantName: null,
          holder: null,
          note: line.description,
          installment: null,
          original: null,
        };
        break;
      }

      case 'credito_percepcion': {
        // La vuelta del viaje anterior: ARCA devuelve y la plata regresa.
        mv = {
          type: 'transferencia',
          date: line.date,
          amountMinor: Math.abs(line.amountMinor),
          currency: line.currency,
          accountId: ctx.percepcionesAccountId,
          toAccountId: ctx.cardAccountId,
          categoryId: null,
          merchantName: null,
          holder: null,
          note: line.description,
          installment: null,
          original: null,
        };
        break;
      }

      case 'impuesto':
      case 'interes': {
        // Éstos sí son gasto, y del que no se ve: nadie revisa el resumen
        // línea por línea para descubrir cuánto se fue en sellos e intereses.
        mv = {
          type: 'gasto',
          date: line.date,
          amountMinor: Math.abs(line.amountMinor),
          currency: line.currency,
          accountId: ctx.cardAccountId,
          toAccountId: null,
          categoryId: line.kind === 'impuesto' ? ctx.categoryIds.impuestos : ctx.categoryIds.intereses,
          merchantName: null,
          holder: null,
          note: line.description,
          installment: null,
          original: null,
        };
        break;
      }

      default:
        movements.push(ignorar('No se pudo clasificar este renglón'));
        continue;
    }

    movements.push({
      fingerprint: fp,
      status: yaEsta ? 'ya_importado' : 'nuevo',
      reason,
      line,
      movement: mv,
    });
  }

  const nuevos = movements.filter((m) => m.status === 'nuevo');
  const gastos = nuevos.filter((m) => m.movement?.type === 'gasto');

  return {
    statement: st,
    movements,
    summary: {
      nuevos: nuevos.length,
      yaImportados: movements.filter((m) => m.status === 'ya_importado').length,
      ignorados: movements.filter((m) => m.status === 'ignorado').length,
      gastoNuevoMinor: gastos
        .filter((m) => m.movement!.currency === 'ARS')
        .reduce((s, m) => s + m.movement!.amountMinor, 0),
      gastoNuevoUsdCents: gastos
        .filter((m) => m.movement!.currency === 'USD')
        .reduce((s, m) => s + m.movement!.amountMinor, 0),
      percepcionRecuperableMinor: nuevos
        .filter((m) => m.line.kind === 'percepcion_recuperable')
        .reduce((s, m) => s + Math.abs(m.line.amountMinor), 0),
    },
  };
}
