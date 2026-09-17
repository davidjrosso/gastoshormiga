import { useEffect, useState } from 'react';
import { useRefresh } from '../App';
import { api, type HormigaItem, type SubscriptionItem } from '../lib/api';
import { money, moneyShort, pct } from '../lib/format';

/**
 * La pantalla que justifica que esta app exista.
 *
 * El criterio de presentación es uno solo: mostrar el número que duele.
 * "$3.250 por café" no mueve a nadie; "$585.000 al año, o USD 434" sí.
 * Anualizar no es un adorno — es la única forma de que un gasto chico y
 * repetido se vuelva visible al lado de un gasto grande y único.
 */
export default function Hormiga() {
  const [months, setMonths] = useState(3);
  const [items, setItems] = useState<HormigaItem[]>([]);
  const [subs, setSubs] = useState<SubscriptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const { token } = useRefresh();

  useEffect(() => {
    setLoading(true);
    Promise.all([api.hormiga(months), api.subscriptions(6)])
      .then(([h, s]) => { setItems(h); setSubs(s); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [months, token]);

  const totalAnnual = items.reduce((s, i) => s + i.annualizedMinor, 0);
  const totalAnnualUsd = items.reduce((s, i) => s + (i.annualizedUsdCents ?? 0), 0);
  const undeclared = subs.filter((s) => !s.isDeclaredFixed);
  const hikes = subs.filter((s) => s.priceChangePct != null && s.priceChangePct >= 20);

  return (
    <div className="space-y-3 p-3">
      <header className="px-1 pt-2">
        <h1 className="text-lg font-bold">Gasto hormiga</h1>
        <p className="text-sm text-ink-mute dark:text-slate-400">
          Compras chicas y repetidas que no se notan de a una.
        </p>
      </header>

      <div className="flex gap-2 px-1">
        {[3, 6, 12].map((m) => (
          <button
            key={m}
            onClick={() => setMonths(m)}
            className={`chip ring-1 ${
              months === m
                ? 'bg-ant text-white ring-transparent'
                : 'bg-white text-ink ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-800'
            }`}
          >
            {m} meses
          </button>
        ))}
      </div>

      {loading && <p className="p-4 text-ink-mute">calculando…</p>}

      {!loading && items.length === 0 && (
        <div className="card">
          <p className="font-medium">Todavía no hay nada que marcar.</p>
          <p className="mt-1 text-sm text-ink-mute dark:text-slate-400">
            Para detectar un goteo hacen falta al menos un par de meses de gastos
            con el comercio cargado. Si venís anotando sin poner dónde comprás,
            el detector no tiene con qué agrupar.
          </p>
        </div>
      )}

      {items.length > 0 && (
        <div className="card bg-ant/10 ring-ant/30 dark:bg-ant/10">
          <p className="label">Si cortaras todo esto</p>
          <p className="tabular mt-1 text-3xl font-bold text-ant-deep dark:text-ant">
            {money(totalAnnual)}
          </p>
          <p className="text-sm text-ink-soft dark:text-slate-300">
            al año
            {totalAnnualUsd > 0 && <> · {money(totalAnnualUsd, 'USD')}</>}
          </p>
        </div>
      )}

      {items.map((item) => (
        <div key={item.merchantId ?? item.merchantName} className="card">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="truncate font-semibold">{item.merchantName}</h2>
            {item.categoryName && (
              <span className="shrink-0 text-xs text-ink-mute dark:text-slate-400">
                {item.categoryName}
              </span>
            )}
          </div>

          <p className="mt-2 text-sm text-ink-soft dark:text-slate-300">
            <strong className="tabular">{item.count}</strong> compras de{' '}
            <strong className="tabular">{money(item.avgMinor)}</strong> en promedio,{' '}
            <strong className="tabular">{item.timesPerMonth}</strong> veces por mes.
          </p>

          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-200 pt-3 dark:border-slate-800">
            <div>
              <p className="label">Por mes</p>
              <p className="tabular text-lg font-semibold">{moneyShort(item.monthlyAvgMinor)}</p>
            </div>
            <div>
              <p className="label">Al año</p>
              <p className="tabular text-lg font-semibold text-ant-deep dark:text-ant">
                {moneyShort(item.annualizedMinor)}
              </p>
              {item.annualizedUsdCents != null && (
                <p className="tabular text-xs text-ink-mute dark:text-slate-400">
                  {money(item.annualizedUsdCents, 'USD')}
                </p>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* Aumentos silenciosos */}
      {hikes.length > 0 && (
        <>
          <h2 className="px-1 pt-4 text-base font-bold">Te aumentaron y no avisaron</h2>
          {hikes.map((s) => (
            <div key={s.merchantId} className="card">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-semibold">{s.merchantName}</span>
                <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-sm font-bold text-red-700 dark:bg-red-950 dark:text-red-300">
                  {pct(s.priceChangePct, true)}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink-mute dark:text-slate-400">
                Hoy pagás <strong className="tabular">{money(s.amountMinor)}</strong> por mes.
                Son <strong className="tabular">{moneyShort(s.annualMinor)}</strong> al año.
              </p>
            </div>
          ))}
        </>
      )}

      {/* Cargos recurrentes sin declarar */}
      {undeclared.length > 0 && (
        <>
          <h2 className="px-1 pt-4 text-base font-bold">Se repiten todos los meses</h2>
          <p className="px-1 text-sm text-ink-mute dark:text-slate-400">
            Los encontramos en tu historial, pero no los tenés cargados como gasto fijo.
            Declararlos hace que el resumen del mes deje de sorprenderte.
          </p>
          {undeclared.map((s) => (
            <div key={s.merchantId} className="card">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-semibold">{s.merchantName}</span>
                <span className="tabular shrink-0 font-semibold">{money(s.amountMinor)}</span>
              </div>
              <p className="mt-1 text-xs text-ink-mute dark:text-slate-400">
                {s.occurrences} cargos · {s.cadence} · próximo alrededor del{' '}
                {s.nextExpectedDate.slice(8)}/{s.nextExpectedDate.slice(5, 7)} ·{' '}
                {moneyShort(s.annualMinor)} al año
              </p>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
