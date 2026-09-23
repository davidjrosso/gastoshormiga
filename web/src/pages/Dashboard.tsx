import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { useAuth, useRefresh } from '../App';
import CategoryExpenses from '../components/CategoryExpenses';
import Installments from '../components/Installments';
import { api, type Dashboard as DashboardData, type HormigaItem, type Summary } from '../lib/api';
import { money, moneyShort, pct, periodLabel, currentPeriod, shiftPeriod } from '../lib/format';

export default function Dashboard() {
  const [period, setPeriod] = useState(currentPeriod());
  const [data, setData] = useState<DashboardData | null>(null);
  const [history, setHistory] = useState<Summary[]>([]);
  const [hormiga, setHormiga] = useState<HormigaItem[]>([]);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const { token } = useRefresh();
  const { me } = useAuth();

  useEffect(() => {
    api.dashboard(period).then(setData).catch(console.error);
  }, [period, token]);

  useEffect(() => {
    api.history(6).then(setHistory).catch(console.error);
    api.hormiga(3).then(setHormiga).catch(console.error);
  }, [token]);

  if (!data) return <div className="p-6 text-ink-mute">cargando…</div>;

  const { summary, previous, trends, savings } = data;

  return (
    <div className="space-y-3 p-3">
      <header className="flex items-center justify-between px-1 pt-2">
        <button
          className="rounded-lg px-3 py-1 text-xl text-ink-mute"
          onClick={() => setPeriod(shiftPeriod(period, 1))}
          aria-label="Mes anterior"
        >
          ‹
        </button>
        <h1 className="text-lg font-bold capitalize">{periodLabel(period)}</h1>
        <button
          className="rounded-lg px-3 py-1 text-xl text-ink-mute disabled:opacity-25"
          onClick={() => setPeriod(shiftPeriod(period, -1))}
          aria-label="Mes siguiente"
        >
          ›
        </button>
      </header>

      {/* Balance del mes */}
      <div className="card">
        <p className="label">{period > currentPeriod() ? 'Balance de movimientos confirmados' : 'Quedó en el mes'}</p>
        <p
          className={`mt-1 text-4xl font-bold tabular ${
            summary.balanceMinor >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
          }`}
        >
          {money(summary.balanceMinor)}
        </p>
        {summary.savingsRatePct != null && (
          <p className="mt-1 text-sm text-ink-mute dark:text-slate-400">
            Estás ahorrando el <strong>{pct(summary.savingsRatePct)}</strong> de lo que entra
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-200 pt-3 dark:border-slate-800">
          <div>
            <p className="label">Entró</p>
            <p className="tabular text-lg font-semibold text-emerald-600 dark:text-emerald-400">
              {moneyShort(summary.incomeMinor)}
            </p>
          </div>
          <div>
            <p className="label">Salió</p>
            <p className="tabular text-lg font-semibold text-red-600 dark:text-red-400">
              {moneyShort(summary.expenseMinor)}
            </p>
          </div>
          <div>
            <p className="label">Fijos</p>
            <p className="tabular text-base font-medium">{moneyShort(summary.fixedExpenseMinor)}</p>
          </div>
          <div>
            <p className="label">Del día a día</p>
            <p className="tabular text-base font-medium">{moneyShort(summary.variableExpenseMinor)}</p>
          </div>
        </div>

        {summary.expenseUsdCents != null && (
          <p className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-sm text-ink-soft dark:bg-slate-800 dark:text-slate-300">
            En dólares del momento gastaste{' '}
            <strong className="tabular">{money(summary.expenseUsdCents, 'USD')}</strong>.
            {summary.habitualExpenseUsdCents != null && previous.habitualExpenseUsdCents != null && previous.habitualExpenseUsdCents > 0 && (
              <>
                {' '}Para comparar, el gasto habitual fue {money(summary.habitualExpenseUsdCents, 'USD')}; el mes pasado, {money(previous.habitualExpenseUsdCents, 'USD')}. Sin eventos extraordinarios.
              </>
            )}
          </p>
        )}
      </div>

      <Installments period={period} />
      <Link to="/eventos" className="card block"><p className="font-semibold">Eventos</p><p className="mt-1 text-sm text-ink-mute dark:text-slate-400">Vacaciones, cumpleaños y otros gastos para mirar por separado →</p></Link>

      {/* Evolución */}
      {history.length > 1 && (
        <div className="card">
          <p className="label mb-2">Últimos meses · gastos habituales</p>
          <p className="mb-2 text-xs text-ink-mute dark:text-slate-400">Sin eventos extraordinarios. Los totales del mes los incluyen.</p>
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={history.map((h) => ({
                mes: periodLabel(h.period).slice(0, 3),
                Gastos: h.habitualExpenseMinor / 100,
                Ingresos: h.incomeMinor / 100,
              }))}>
                <XAxis dataKey="mes" tickLine={false} axisLine={false}
                       tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <Tooltip
                  formatter={(v: number) => money(v * 100)}
                  contentStyle={{ borderRadius: 12, fontSize: 12, border: 'none',
                                  boxShadow: '0 4px 12px rgba(0,0,0,.15)' }}
                />
                <Bar dataKey="Ingresos" fill="#34d399" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Gastos" fill="#fb923c" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Aviso de gasto hormiga */}
      {hormiga.length > 0 && (
        <Link to="/hormiga" className="card block ring-2 ring-ant/30">
          <div className="flex items-start gap-3">
            <span className="text-2xl">🐜</span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {hormiga.length === 1
                  ? 'Detectamos un goteo'
                  : `Detectamos ${hormiga.length} goteos`}
              </p>
              <p className="mt-0.5 text-sm text-ink-mute dark:text-slate-400">
                {hormiga[0].merchantName} se lleva{' '}
                <strong className="tabular">{moneyShort(hormiga[0].annualizedMinor)}</strong> al año
                en compras de {money(hormiga[0].avgMinor)}.
              </p>
              <p className="mt-1 text-sm font-medium text-ant">Ver el detalle →</p>
            </div>
          </div>
        </Link>
      )}

      {/* Ahorro en dólares */}
      {savings.usdHeldCents > 0 && (
        <Link to="/ahorros" className="card block">
          <p className="label">Ahorro en dólares</p>
          <p className="tabular mt-1 text-2xl font-bold">
            {money(savings.usdHeldCents, 'USD')}
          </p>
          {savings.usdValueInArsMinor != null && (
            <p className="mt-0.5 text-sm text-ink-mute dark:text-slate-400">
              ≈ {moneyShort(savings.usdValueInArsMinor)} de hoy
            </p>
          )}
        </Link>
      )}

      {/* Quién puso qué. Solo tiene sentido si el hogar tiene más de una persona. */}
      {me && me.members.length > 1 && data.byMember.some((m) => m.expenseMinor > 0) && (
        <div className="card">
          <p className="label mb-3">Quién pagó qué</p>
          <div className="space-y-3">
            {data.byMember
              .filter((m) => m.expenseMinor > 0)
              .map((m) => {
                const nombre = m.userId === me.user.id
                  ? 'Vos'
                  : me.members.find((x) => x.id === m.userId)?.displayName ?? 'Sin asignar';
                const parte = summary.expenseMinor > 0
                  ? (m.expenseMinor / summary.expenseMinor) * 100
                  : 0;
                return (
                  <div key={m.userId ?? 'nadie'}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate font-medium">{nombre}</span>
                      <span className="tabular shrink-0 font-semibold">
                        {moneyShort(m.expenseMinor)}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                      <div
                        className="h-full rounded-full bg-ant"
                        style={{ width: `${parte}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-xs text-ink-mute dark:text-slate-400">
                      {pct(Math.round(parte * 10) / 10)} de los gastos · {m.txCount} movimientos
                    </p>
                  </div>
                );
              })}
          </div>
          <p className="mt-3 text-xs text-ink-mute dark:text-slate-400">
            Es quién puso la plata, no quién cargó el dato en la app.
          </p>
        </div>
      )}

      {/* Categorías */}
      <div className="card">
        <p className="label mb-3">En qué se fue</p>
        {trends.length === 0 && (
          <p className="text-sm text-ink-mute dark:text-slate-400">
            Todavía no hay gastos cargados este mes.
          </p>
        )}
        <div className="space-y-2.5">
          {trends.map((t) => {
            const categoryKey = t.categoryId ?? 'uncategorized';
            const expanded = expandedCategory === categoryKey;
            const width = trends[0].currentMinor > 0
              ? (t.currentMinor / trends[0].currentMinor) * 100
              : 0;
            return (
              <div key={t.categoryId ?? 'null'}>
                <button
                  type="button"
                  className="block w-full rounded-lg py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ant"
                  aria-expanded={expanded}
                  aria-controls={`category-expenses-${categoryKey}`}
                  onClick={() => setExpandedCategory(expanded ? null : categoryKey)}
                >
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 break-words font-medium"><span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {t.categoryName}</span>
                  <span className="tabular shrink-0 font-semibold">
                    {moneyShort(t.currentMinor)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className="h-full rounded-full"
                       style={{ width: `${width}%`, backgroundColor: t.color }} />
                </div>
                <div className="mt-0.5 flex justify-between text-xs text-ink-mute dark:text-slate-400">
                  <span>
                    {t.shareOfIncomePct != null ? `${pct(t.shareOfIncomePct)} del ingreso` : ''}
                  </span>
                  {t.changePct != null && (
                    <span className={t.changePct > 15 ? 'font-medium text-red-600 dark:text-red-400' : ''}>
                      {pct(t.changePct, true)} habitual vs. meses previos
                    </span>
                  )}
                </div>
                {t.habitualMinor !== t.currentMinor && <p className="mt-1 text-xs text-ink-mute dark:text-slate-400">Habitual: {money(t.habitualMinor)} · el total incluye eventos extraordinarios.</p>}
                </button>
                <div id={`category-expenses-${categoryKey}`} hidden={!expanded}>
                  {expanded && <CategoryExpenses key={`${period}:${token}:${categoryKey}`} period={period} categoryId={t.categoryId} />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
