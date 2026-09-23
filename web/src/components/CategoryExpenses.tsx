import { useEffect, useState } from 'react';
import { useAuth } from '../App';
import { api, type Transaction } from '../lib/api';
import { dayLabel, money } from '../lib/format';

export default function CategoryExpenses({ period, categoryId }: {
  period: string;
  categoryId: string | null;
}) {
  const { me } = useAuth();
  const [items, setItems] = useState<Transaction[] | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setItems(null);
    setError(false);
    async function load() {
      const all: Transaction[] = [];
      while (active) {
        const page = await api.transactions({ period, categoryId, type: 'gasto', limit: 1000, offset: all.length });
        if (!active) return;
        all.push(...page);
        if (page.length < 1000) {
          setItems(all);
          return;
        }
      }
    }
    load().catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [period, categoryId, retry]);

  if (error) return (
    <div role="alert" className="py-3 text-sm">
      No se pudieron cargar los gastos.{' '}
      <button className="font-medium text-ant underline" onClick={() => setRetry(retry + 1)}>Reintentar</button>
    </div>
  );
  if (!items) return <p role="status" className="py-3 text-sm text-ink-mute">Cargando gastos…</p>;
  if (!items.length) return <p className="py-3 text-sm text-ink-mute">No hay gastos de esta categoría en este mes.</p>;

  return (
    <div className="mt-2 rounded-xl bg-slate-50 px-3 dark:bg-slate-950">
      <p className="pt-3 text-xs text-ink-mute dark:text-slate-400">{items.length} {items.length === 1 ? 'gasto' : 'gastos'}</p>
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {items.map((tx) => (
          <li key={tx.id} className="py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="min-w-0 flex-1 break-words font-medium">{tx.merchantName || tx.note || 'Sin detalle'}</p>
              <p className="tabular font-semibold">{money(tx.amountMinor, tx.currency as 'ARS' | 'USD')}</p>
            </div>
            <p className="mt-1 text-xs text-ink-mute dark:text-slate-400">
              {dayLabel(tx.date)} · {me?.members.find((m) => m.id === tx.paidByUserId)?.displayName ?? 'Sin asignar'}
              {tx.accountName ? ` · ${tx.accountName}` : ''}
            </p>
            {tx.merchantName && tx.note && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-mute dark:text-slate-400">{tx.note}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
