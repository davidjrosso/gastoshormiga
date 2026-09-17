import { useEffect, useState } from 'react';
import { useRefresh } from '../App';
import { api, type Account, type FxRate, type SavingsSummary } from '../lib/api';
import { money, moneyShort, pct } from '../lib/format';

export default function Ahorros() {
  const [savings, setSavings] = useState<SavingsSummary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rates, setRates] = useState<FxRate[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const { token } = useRefresh();

  useEffect(() => {
    Promise.all([api.savings(), api.accounts(), api.dashboard()])
      .then(([s, a, d]) => { setSavings(s); setAccounts(a); setRates(d.rates); })
      .catch(console.error);
  }, [token]);

  async function refreshRates() {
    setRefreshing(true);
    try {
      setRates(await api.refreshFx());
      setSavings(await api.savings());
    } catch {
      /* la API pública puede estar caída; se puede cargar a mano en Ajustes */
    } finally {
      setRefreshing(false);
    }
  }

  if (!savings) return <div className="p-6 text-ink-mute">cargando…</div>;

  const usdAccounts = accounts.filter((a) => a.currency === 'USD');
  const arsAccounts = accounts.filter((a) => a.currency === 'ARS');

  return (
    <div className="space-y-3 p-3">
      <header className="px-1 pt-2">
        <h1 className="text-lg font-bold">Ahorros</h1>
        <p className="text-sm text-ink-mute dark:text-slate-400">
          Lo que se ahorra de verdad, medido en la moneda en que se ahorra.
        </p>
      </header>

      <div className="card">
        <p className="label">Dólares</p>
        <p className="tabular mt-1 text-4xl font-bold">{money(savings.usdHeldCents, 'USD')}</p>
        {savings.usdValueInArsMinor != null && (
          <p className="mt-1 text-sm text-ink-mute dark:text-slate-400">
            ≈ {money(savings.usdValueInArsMinor)} a la cotización de hoy
          </p>
        )}

        {savings.avgPurchaseRateMinor != null && (
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-200 pt-3 dark:border-slate-800">
            <div>
              <p className="label">Los compraste a</p>
              <p className="tabular text-base font-semibold">
                {money(savings.avgPurchaseRateMinor)}
              </p>
              <p className="text-xs text-ink-mute dark:text-slate-400">promedio ponderado</p>
            </div>
            <div>
              <p className="label">Hoy están a</p>
              <p className="tabular text-base font-semibold">
                {savings.currentRateMinor != null ? money(savings.currentRateMinor) : '—'}
              </p>
              {savings.unrealizedPct != null && (
                <p className={`text-xs font-medium ${
                  savings.unrealizedPct >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400'
                }`}>
                  {pct(savings.unrealizedPct, true)} en pesos
                </p>
              )}
            </div>
          </div>
        )}

        {savings.unrealizedArsMinor != null && (
          <p className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-xs text-ink-soft dark:bg-slate-800 dark:text-slate-300">
            Esa diferencia de {moneyShort(savings.unrealizedArsMinor)} no es ganancia:
            es el peso que se depreció. Tus dólares son los mismos.
          </p>
        )}
      </div>

      {savings.netWorthUsdCents != null && (
        <div className="card">
          <p className="label">Todo lo que tienen, en dólares</p>
          <p className="tabular mt-1 text-2xl font-bold">
            {money(savings.netWorthUsdCents, 'USD')}
          </p>
          <p className="mt-0.5 text-sm text-ink-mute dark:text-slate-400">
            Pesos líquidos + dólares, valuado a hoy
          </p>
        </div>
      )}

      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <p className="label">Cotizaciones</p>
          <button
            onClick={refreshRates}
            disabled={refreshing}
            className="text-sm font-medium text-ant disabled:opacity-50"
          >
            {refreshing ? 'actualizando…' : 'actualizar'}
          </button>
        </div>
        {rates.length === 0 ? (
          <p className="text-sm text-ink-mute dark:text-slate-400">
            Sin cotizaciones todavía. Tocá "actualizar", o cargalas a mano desde Ajustes
            si el servidor no tiene salida a internet.
          </p>
        ) : (
          <div className="space-y-1.5">
            {rates.map((r) => (
              <div key={r.type} className="flex justify-between text-sm">
                <span className="capitalize">{r.type}</span>
                <span className="tabular font-medium">
                  {money(r.buyMinor, 'ARS', false)} / {money(r.sellMinor, 'ARS', false)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <p className="label mb-3">Cuentas</p>
        <div className="space-y-2">
          {[...usdAccounts, ...arsAccounts].map((a) => (
            <div key={a.accountId} className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{a.name}</p>
                <p className="text-xs capitalize text-ink-mute dark:text-slate-400">{a.type}</p>
              </div>
              <span className={`tabular font-semibold ${
                a.balanceMinor < 0 ? 'text-red-600 dark:text-red-400' : ''
              }`}>
                {money(a.balanceMinor, a.currency as 'ARS' | 'USD', false)}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-mute dark:text-slate-400">
          Para comprar dólares, cargá una <strong>transferencia</strong> de la cuenta en
          pesos a la cuenta en dólares. Nunca como gasto: la plata no salió de casa,
          solo cambió de moneda.
        </p>
      </div>
    </div>
  );
}
