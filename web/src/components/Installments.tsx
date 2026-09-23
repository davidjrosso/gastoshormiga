import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRefresh } from '../App';
import { api, type InstallmentForecast } from '../lib/api';
import { money, pct, periodLabel } from '../lib/format';

export default function Installments({ period, months = 6, paidBy = '', eventId }: { period: string; months?: number; paidBy?: string; eventId?: string | null }) {
  const { token } = useRefresh();
  const [data, setData] = useState<InstallmentForecast | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    api.installments(period, months, paidBy, eventId).then(result => { if (active) setData(result); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [period, months, paidBy, eventId, token, retry]);

  return <section className="card" aria-label="Cuotas comprometidas">
    <h2 className="font-semibold">Cuotas comprometidas</h2>
    <p className="mt-1 text-xs text-ink-mute dark:text-slate-400">
      Estimadas por mes de cierre. Se muestran aparte de los gastos confirmados y conservan el importe de la última cuota.
    </p>
    {error ? <p role="alert" className="mt-3 text-sm">No pudimos consultar las cuotas. <button className="text-ant underline" onClick={() => setRetry(r => r + 1)}>Reintentar</button></p>
      : !data ? <p className="mt-3 text-sm" role="status">Cargando cuotas…</p>
      : <>
        {!data.sources.length ? <p className="mt-3 text-sm">Confirmá un resumen e incorporá sus consumos al hogar desde <Link className="text-ant underline" to="/tarjetas">Tarjetas</Link>.</p>
          : <>
            <p className="mt-2 text-xs text-ink-mute dark:text-slate-400">
              Base: {data.sources.map(source => `${source.accountName}, cierre ${source.closeDate}`).join(' · ')}.
            </p>
            {data.sources.some(source => !source.hasHouseholdMovements) && <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
              Hay tarjetas cuyo último resumen no tiene consumos incorporados al hogar. Revisá <Link className="underline" to="/tarjetas">Tarjetas</Link> para incluirlas.
            </p>}
            <div className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
              {data.months.map(month => <details key={month.period} className="py-3" open={months === 1 ? true : undefined}>
                <summary className="cursor-pointer text-sm">
                  <span className="font-medium capitalize">{periodLabel(month.period)}</span>
                  <span className="tabular ml-2 font-semibold">{money(month.arsMinor)}{month.usdCents > 0 && ` + ${money(month.usdCents, 'USD')}`}</span>
                  {month.items.length > 0 && <span className="mt-1 block text-xs text-ink-mute dark:text-slate-400">
                    {month.items.length} {month.items.length === 1 ? 'cuota prevista' : 'cuotas previstas'}{month.shareOfIncomePct !== null && ` · ${pct(month.shareOfIncomePct)} del ingreso de referencia (solo pesos)`}
                  </span>}
                </summary>
                {!month.items.length && <p className="mt-2 text-xs text-ink-mute dark:text-slate-400">No hay cuotas pendientes proyectadas con los resúmenes disponibles. Las ya facturadas figuran en los gastos confirmados.</p>}
                <ul className="mt-2 space-y-3">
                  {month.items.map(item => <li key={`${item.statementId}:${item.lineId}:${item.userId}`} className="rounded-lg bg-slate-50 p-2 text-sm dark:bg-slate-800">
                    <div className="flex flex-wrap justify-between gap-1"><span className="min-w-0 break-words font-medium">{item.description}</span><span className="tabular">{money(item.amountMinor, item.currency)}</span></div>
                    <p className="mt-1 text-xs text-ink-mute dark:text-slate-400">Cuota {item.n}/{item.of} · {item.userName ?? 'Hogar'} · {item.accountName}</p>
                    <p className="mt-1 text-xs">{item.n === item.of ? 'Última cuota este mes' : `Termina en ${periodLabel(item.lastPeriod)}`}</p>
                    {item.eventName && <p className="mt-1 text-xs text-ant">Evento: {item.eventName}</p>}
                  </li>)}
                </ul>
              </details>)}
            </div>
            <p className="mt-2 text-xs text-ink-mute dark:text-slate-400">{data.incomeReference
              ? `Ingreso de referencia: ${money(data.incomeReference.amountMinor)} registrado en ${periodLabel(data.incomeReference.period)}. El ingreso futuro puede cambiar.`
              : 'Sin ingresos recientes en pesos para calcular un porcentaje de referencia.'}</p>
            <details className="mt-3 text-xs text-ink-mute dark:text-slate-400">
              <summary className="cursor-pointer">Resúmenes usados y alcance</summary>
              <ul className="mt-2 space-y-2">{data.sources.map(source => <li key={source.statementId}>
                {source.accountName}: cierre {source.closeDate}, vencimiento {source.dueDate}.
                {!source.hasHouseholdMovements && ' Sin consumos incorporados al hogar: no genera proyección.'}
              </li>)}</ul>
              <p className="mt-2">Cada nuevo resumen confirmado reemplaza la base de esa tarjeta. Si falta un resumen, la estimación puede estar desactualizada. No incluye nuevas compras, cargos futuros ni adicionales en Solo liquidación. Los dólares se muestran sin convertir.</p>
            </details>
          </>}
      </>}
  </section>;
}
