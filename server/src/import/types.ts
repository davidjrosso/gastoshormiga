/**
 * Modelo común de un resumen de tarjeta, independiente del banco.
 *
 * Todo lo que es específico de un banco vive en su parser; de acá para
 * adelante el importador no sabe si el resumen vino de BBVA o de otro lado.
 * Agregar un banco es escribir un parser nuevo que devuelva esto.
 */

/** Qué es cada renglón. La clasificación decide cómo entra a la app, y es lo
 *  que separa un importador útil de uno que arruina el mes. */
export type LineKind =
  /** Tu pago del resumen anterior. NO es un gasto: cancela una deuda. */
  | 'pago'
  /** Una compra. Esto sí es gasto. */
  | 'consumo'
  /** Percepcion RG 5617: la exclusion/devolucion requiere verificar el pago.
   *  No se presume su recuperacion ni un plazo fijo. */
  | 'percepcion_recuperable'
  /** La devolución de esa percepción, en el resumen siguiente. */
  | 'credito_percepcion'
  /** Impuesto o percepcion (IVA RG 4240, IIBB, sellos), sujeto a revision. */
  | 'impuesto'
  /** Intereses de financiación o de adelanto. Gasto. */
  | 'interes'
  /** Adelanto en efectivo o por transferencia. NO es gasto: es plata que
   *  sacaste de la tarjeta y pusiste en otro lado. */
  | 'adelanto'
  /** No lo pudimos clasificar. Nunca se importa en silencio: va a revisión. */
  | 'desconocido';

export interface StatementLine {
  kind: LineKind;
  /** Titular o adicional que hizo el consumo. null en impuestos y pagos. */
  holder: string | null;
  /** Fecha del renglón, 'YYYY-MM-DD'. En una cuota es la fecha de la COMPRA
   *  original, no la del cargo: el resumen la informa así. */
  date: string;
  description: string;
  /** Número de cupón, cuando el renglón lo trae. Sirve para deduplicar. */
  coupon: string | null;
  /** Positivo = cargo, negativo = crédito. Siempre en unidades menores. */
  amountMinor: number;
  currency: 'ARS' | 'USD';
  /** Cuota n de N, cuando corresponde. */
  installment: { n: number; of: number } | null;
  /** Moneda y monto originales de una compra en el exterior que no es USD
   *  (ej. UYU 7.984,07 facturados como USD 200,23). */
  original: { code: string; amount: number } | null;
  /** Base imponible declarada entre paréntesis en las percepciones. */
  taxBaseMinor: number | null;
}

export interface HolderTotal {
  holder: string;
  /** Lo que el resumen dice que gastó. Sirve para verificar el parseo. */
  statedArsMinor: number;
  statedUsdCents: number;
}

export interface ParsedStatement {
  warnings: string[];
  bank: string;
  card: string;
  /** Últimos dígitos de la cuenta. Nunca guardamos el número completo. */
  accountTail: string | null;
  closeDate: string;
  dueDate: string;
  balanceArsMinor: number;
  balanceUsdCents: number;
  minimumArsMinor: number;
  previousArsMinor: number;
  previousUsdCents: number;
  holders: HolderTotal[];
  lines: StatementLine[];
  /**
   * Verificación aritmética contra los totales que declara el propio resumen.
   *
   * Existe porque un parser de PDF falla en silencio: cambia el layout, se
   * pierde un renglón, y el importe queda mal sin que nada se rompa. Si esto
   * no cierra al centavo, el importador no debe dejar confirmar nada.
   */
  check: {
    ok: boolean;
    computedArsMinor: number;
    computedUsdCents: number;
    diffArsMinor: number;
    diffUsdCents: number;
    byHolder: Array<{ holder: string; diffArsMinor: number; diffUsdCents: number }>;
  };
}
