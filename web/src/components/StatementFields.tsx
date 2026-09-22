import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { LedgerLine, StatementDocument } from '../lib/statements';
import { money, proportionalAllocation } from '../lib/statements';

export function MoneyField({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState((value / 100).toFixed(2).replace('.', ','));
  useEffect(() => {
    setText((value / 100).toFixed(2).replace('.', ','));
  }, [value]);
  return (
    <input
      className="st-input st-money"
      aria-label={label}
      inputMode="decimal"
      value={text}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        const clean = v.replace(/\./g, '');
        const valid =
          /^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(,\d{0,2})?$/.test(v) &&
          Math.abs(Number(clean.replace(',', '.'))) <= 10_000_000_000;
        e.target.setCustomValidity(valid ? '' : 'Usa coma decimal y hasta dos decimales.');
      }}
      onBlur={(e) => {
        if (e.target.validity.valid) {
          const n = Math.round(Number(text.replace(/\./g, '').replace(',', '.')) * 100);
          onChange(n);
          setText((n / 100).toFixed(2).replace('.', ','));
        }
      }}
    />
  );
}

export const kindNames: Record<LedgerLine['kind'], string> = {
  consumo: 'Consumo',
  pago: 'Pago al banco',
  percepcion_recuperable: 'Percepcion RG 5617',
  credito_percepcion: 'Credito de percepcion',
  impuesto: 'Impuesto',
  interes: 'Interes',
  adelanto: 'Adelanto',
  desconocido: 'Sin clasificar',
};
export function AllocationEditor({
  line,
  doc,
  onSave,
  onClose,
}: {
  line: LedgerLine;
  doc: StatementDocument;
  onSave: (l: LedgerLine) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<LedgerLine>(() => ({
    ...line,
    allocations: doc.holders.map((h) => ({
      holder: h.holder,
      amountMinor: line.allocations.find((a) => a.holder === h.holder)?.amountMinor ?? 0,
    })),
  }));
  const sum = editing.allocations.reduce((s, a) => s + a.amountMinor, 0);
  return (
    <div className="st-overlay" role="presentation">
      <section className="st-dialog" role="dialog" aria-modal="true" aria-label="Repartir cargo">
        <header>
          <h2>Repartir cargo</h2>
          <button type="button" className="st-icon" title="Cerrar" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <p>{line.description}</p>
        <strong>{money(line.amountMinor, line.currency)}</strong>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave({
              ...editing,
              allocations:
                editing.treatment === 'allocate'
                  ? editing.allocations.filter((a) => a.amountMinor !== 0)
                  : [],
            });
          }}
        >
          <label>
            Tratamiento
            <select
              aria-label="Tratamiento"
              className="st-input"
              value={editing.treatment}
              onChange={(e) =>
                setEditing({ ...editing, treatment: e.target.value as LedgerLine['treatment'] })
              }
            >
              {line.kind !== 'pago' && <option value="allocate">Asignar a personas</option>}
              <option value="pending">Pendiente de asignar</option>
              <option value="excluded">Excluir de lo que deben entregar</option>
            </select>
          </label>
          {editing.treatment === 'allocate' && (
            <label>
              Asignar todo a
              <select
                aria-label="Asignar todo a"
                className="st-input"
                value=""
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    allocations: editing.allocations.map((a) => ({
                      ...a,
                      amountMinor: a.holder === e.target.value ? line.amountMinor : 0,
                    })),
                  })
                }
              >
                <option value="">Elegir persona</option>
                {doc.holders.map((h) => (
                  <option key={h.holder}>{h.holder}</option>
                ))}
              </select>
            </label>
          )}
          {editing.treatment === 'allocate' && (
            <label>
              Propuesta de reparto
              <select
                className="st-input"
                value=""
                onChange={(e) => {
                  const cur = e.target.value;
                  const parts = proportionalAllocation(
                    line.amountMinor,
                    doc.holders.map((h) => ({
                      holder: h.holder,
                      weight: cur === 'ARS' ? h.statedArsMinor : h.statedUsdCents,
                    })),
                  );
                  setEditing({
                    ...editing,
                    reason: `Prorrateo por consumos ${cur}, revisado manualmente`,
                    allocations: doc.holders.map((h) => ({
                      holder: h.holder,
                      amountMinor: parts.find((p) => p.holder === h.holder)?.amountMinor ?? 0,
                    })),
                  });
                }}
              >
                <option value="">Sin prorrateo automatico</option>
                <option value="ARS">Proporcional a consumos ARS</option>
                <option value="USD">Proporcional a consumos USD</option>
              </select>
            </label>
          )}
          {editing.treatment === 'allocate' && (
            <>
              <div className="st-allocation">
                {editing.allocations.map((a, i) => (
                  <label key={a.holder}>
                    {a.holder}
                    <MoneyField
                      value={a.amountMinor}
                      label={`Importe ${a.holder}`}
                      onChange={(n) =>
                        setEditing({
                          ...editing,
                          allocations: editing.allocations.map((v, j) =>
                            j === i ? { ...v, amountMinor: n } : v,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <p className={sum === line.amountMinor ? 'st-ok' : 'st-warning'}>
                Sin distribuir: {money(line.amountMinor - sum, line.currency)}
              </p>
            </>
          )}
          <label>
            Motivo / criterio
            <textarea
              className="st-input"
              maxLength={500}
              required={editing.treatment === 'excluded'}
              value={editing.reason}
              onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
            />
          </label>
          <footer>
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button
              className="btn-primary"
              disabled={editing.treatment === 'allocate' && sum !== line.amountMinor}
            >
              Aplicar reparto
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
