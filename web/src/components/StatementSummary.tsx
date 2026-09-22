import { money, type summarize, type Settlement } from '../lib/statements';

type Row = ReturnType<typeof summarize>['rows'][number];
const columns = [
  ['consumption', 'Consumos'],
  ['charges', 'Impuestos y cargos'],
  ['advances', 'Adelantos'],
  ['adjustments', 'Ajustes'],
  ['total', 'A entregar'],
  ['paid', 'Recibido'],
  ['assumed', 'Asumido'],
  ['remaining', 'Pendiente'],
] as const;

export default function StatementSummary({
  rows,
  editable,
  onSettlement,
}: {
  rows: Row[];
  editable: boolean;
  onSettlement: (entry: Settlement) => void;
}) {
  const register = (r: Row) =>
    onSettlement({
      id: crypto.randomUUID(),
      holder: r.holder,
      currency: r.currency,
      amountMinor: r.remaining,
      kind: 'payment',
      date: new Date().toLocaleDateString('en-CA'),
      note: '',
    });
  const action = (r: Row) =>
    !editable && r.remaining > 0 ? (
      <button type="button" className="btn-ghost" onClick={() => register(r)}>
        Registrar
      </button>
    ) : null;
  return (
    <>
      <div className="st-table-wrap st-summary-desktop">
        <table className="st-summary">
          <thead>
            <tr>
              <th>Persona / moneda</th>
              {columns.map(([key, label]) => (
                <th key={key}>{label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.holder}-${r.currency}`}>
                <th>
                  {r.holder}
                  <small>{r.currency}</small>
                </th>
                {columns.map(([key]) => (
                  <td className={key === 'remaining' ? 'st-emphasis' : ''} key={key}>
                    {money(r[key], r.currency)}
                  </td>
                ))}
                <td>{action(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="st-summary-mobile">
        {rows.map((r) => (
          <article key={`${r.holder}-${r.currency}`}>
            <header>
              <h2>{r.holder}</h2>
              <small>{r.currency}</small>
            </header>
            <dl>
              {columns.map(([key, label]) => (
                <div key={key} className={key === 'remaining' ? 'st-person-balance' : ''}>
                  <dt>{label}</dt>
                  <dd>{money(r[key], r.currency)}</dd>
                </div>
              ))}
            </dl>
            {action(r)}
          </article>
        ))}
      </div>
    </>
  );
}
