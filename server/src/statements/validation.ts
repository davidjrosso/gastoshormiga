import { z } from 'zod';
import { validDate } from './model.js';

const minor = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000);
const name = z.string().trim().min(1).max(120);
const currency = z.enum(['ARS', 'USD']);
export const documentSchema = z
  .object({
    accountId: z.string().max(100),
    closeDate: z.string().max(10),
    dueDate: z.string().max(10),
    accountTail: z.string().regex(/^\d{0,4}$/),
    balanceArsMinor: minor,
    balanceUsdCents: minor,
    previousArsMinor: minor,
    previousUsdCents: minor,
    dollarPayment: currency,
    reviewConfirmed: z.boolean(),
    extractionWarnings: z.array(z.string().max(500)).max(100),
    holders: z
      .array(z.object({ holder: name, statedArsMinor: minor, statedUsdCents: minor }))
      .min(1)
      .max(30),
    lines: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          date: z.string().max(10),
          description: z.string().max(300),
          kind: z.enum([
            'consumo',
            'pago',
            'percepcion_recuperable',
            'credito_percepcion',
            'impuesto',
            'interes',
            'adelanto',
            'desconocido',
          ]),
          holder: name.nullable(),
          amountMinor: minor,
          currency,
          coupon: z.string().max(30).nullable(),
          installment: z
            .object({ n: z.number().int().min(1).max(999), of: z.number().int().min(1).max(999) })
            .refine((v) => v.n <= v.of)
            .nullable(),
          original: z.object({ code: z.string().max(3), amount: z.number().finite() }).nullable(),
          taxBaseMinor: minor.nullable(),
          treatment: z.enum(['allocate', 'pending', 'excluded']),
          reason: z.string().max(500),
          allocations: z.array(z.object({ holder: name, amountMinor: minor })).max(30),
        }),
      )
      .max(1000),
  })
  .refine(
    (d) => new Set(d.lines.map((l) => l.id)).size === d.lines.length,
    'Movimientos repetidos.',
  );
export const settlementSchema = z.object({
  id: z.string().uuid(),
  holder: name,
  currency,
  amountMinor: minor.refine((n) => n > 0),
  kind: z.enum(['payment', 'assumed']),
  date: z.string().refine(validDate),
  note: z.string().trim().min(1).max(300),
});
