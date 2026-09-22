import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  FileUp,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  Split,
  Check,
  Printer,
} from 'lucide-react';
import { api, type Account } from '../lib/api';
import {
  statements,
  summarize,
  money,
  type StatementRecord,
  type StatementListItem,
  type LedgerLine,
  type Settlement,
} from '../lib/statements';
import { AllocationEditor, MoneyField, kindNames } from '../components/StatementFields';
import StatementSummary from '../components/StatementSummary';
import '../statements.css';

const dateLabel = (date: string) => (date ? date.split('-').reverse().join('/') : 'Sin cierre');
export default function Tarjetas() {
  const [list, setList] = useState<StatementListItem[]>([]);
  const [record, setRecord] = useState<StatementRecord | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState('');
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [text, setText] = useState('');
  const [tab, setTab] = useState('personas');
  const [filter, setFilter] = useState('');
  const [allocation, setAllocation] = useState<LedgerLine | null>(null);
  const [entry, setEntry] = useState<Settlement | null>(null);
  const [dirty, setDirty] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const file = useRef<HTMLInputElement>(null);
  async function load() {
    setList(await statements.list());
  }
  useEffect(() => {
    void Promise.all([statements.list(), api.accounts()])
      .then(([l, a]) => {
        setList(l);
        setAccounts(a.filter((v) => v.type === 'tarjeta'));
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function act(message: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(message);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo completar la operacion.');
    } finally {
      lock.current = false;
      setBusy('');
    }
  }
  function update(doc: StatementRecord['document']) {
    if (record) {
      setRecord({ ...record, document: { ...doc, reviewConfirmed: false } });
      setDirty(true);
    }
  }
  function lineChange(line: LedgerLine) {
    if (record)
      update({
        ...record.document,
        lines: record.document.lines.map((l) => (l.id === line.id ? line : l)),
      });
  }
  function accept(r: StatementRecord) {
    setRecord(r);
    setDirty(false);
  }
  const doc = record?.document;
  const summary = doc ? summarize(doc, record?.settlements) : null;
  const editable = record?.status === 'draft';
  const rows = summary?.rows.filter((r) => r.total || r.remaining || r.paid || r.assumed) ?? [];
  async function upload(selected: File) {
    await act('Leyendo PDF y verificando importes...', async () => {
      const result = await statements.analyze(selected);
      accept(result.record);
      setText(result.text);
      setTab('personas');
      setNotice(
        result.duplicate
          ? 'Este archivo ya estaba cargado. Se abrio el resumen existente.'
          : 'Borrador listo para revisar.',
      );
      await load();
    });
  }
  async function save(confirm: boolean) {
    if (!record || !form.current?.reportValidity()) return;
    await act(confirm ? 'Confirmando liquidacion...' : 'Guardando borrador...', async () => {
      accept(await statements.save(record, confirm));
      setNotice(confirm ? 'Liquidacion confirmada.' : 'Borrador guardado.');
      await load();
    });
  }
  return (
    <main className="statements">
      <header className="st-heading">
        <div>
          <h1>Tarjetas y adicionales</h1>
          <p>
            {record
              ? `${record.sourceName} · ${record.status === 'draft' ? 'Borrador' : 'Confirmado'}`
              : 'Resumenes y liquidaciones'}
          </p>
        </div>
        {record ? (
          <button
            className="st-icon"
            title="Volver a resumenes"
            disabled={!!busy}
            onClick={() => {
              if (!dirty || confirm('Hay cambios sin guardar. ¿Salir?')) {
                setRecord(null);
                setDirty(false);
                setText('');
              }
            }}
          >
            <ArrowLeft />
          </button>
        ) : (
          <button
            className="btn-primary st-command"
            disabled={!!busy}
            onClick={() => file.current?.click()}
          >
            <FileUp size={18} /> Cargar PDF
          </button>
        )}
        <input
          ref={file}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
      </header>
      {busy && (
        <div className="st-status" role="status">
          <LoaderCircle className="animate-spin" size={20} />
          {busy}
        </div>
      )}
      {error && (
        <div className="st-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="st-status" role="status">
          {notice}
        </div>
      )}
      {!record && (
        <section>
          <h2>Resumenes cargados</h2>
          {!list.length && !busy && <p className="st-empty">No hay resumenes cargados.</p>}
          <div className="st-list">
            {list.map((r) => (
              <button
                key={r.id}
                disabled={!!busy}
                onClick={() =>
                  void act('Abriendo resumen...', async () => {
                    accept(await statements.get(r.id));
                    setTab('personas');
                    setFilter('');
                  })
                }
              >
                <span>
                  <strong>{dateLabel(r.closeDate)}</strong>
                  <small>{r.sourceName}</small>
                </span>
                <span>
                  {r.status === 'draft' ? 'Borrador' : 'Confirmado'}
                  {r.summary.pending > 0 && <small>{r.summary.pending} cargos sin asignar</small>}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {record && doc && summary && (
        <>
          <form
            ref={form}
            onSubmit={(e) => {
              e.preventDefault();
              void save(false);
            }}
          >
            <fieldset disabled={!!busy}>
              <div className="st-metadata">
                <label>
                  Tarjeta
                  <select
                    className="st-input"
                    disabled={!editable}
                    value={doc.accountId}
                    onChange={(e) => update({ ...doc, accountId: e.target.value })}
                  >
                    <option value="">Seleccionar tarjeta</option>
                    {accounts.map((a) => (
                      <option key={a.accountId} value={a.accountId}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Cierre
                  <input
                    className="st-input"
                    type="date"
                    disabled={!editable}
                    value={doc.closeDate}
                    onChange={(e) => update({ ...doc, closeDate: e.target.value })}
                  />
                </label>
                <label>
                  Vencimiento
                  <input
                    className="st-input"
                    type="date"
                    disabled={!editable}
                    value={doc.dueDate}
                    onChange={(e) => update({ ...doc, dueDate: e.target.value })}
                  />
                </label>
                <label>
                  Pago de dolares
                  <select
                    className="st-input"
                    disabled={!editable}
                    value={doc.dollarPayment}
                    onChange={(e) =>
                      update({ ...doc, dollarPayment: e.target.value as 'USD' | 'ARS' })
                    }
                  >
                    <option value="USD">Con dolares</option>
                    <option value="ARS">Con pesos</option>
                  </select>
                </label>
              </div>
              {editable && (
                <details className="st-details">
                  <summary>Saldos del banco y titulares</summary>
                  <div className="st-metadata">
                    {(
                      [
                        'balanceArsMinor',
                        'balanceUsdCents',
                        'previousArsMinor',
                        'previousUsdCents',
                      ] as const
                    ).map((key, i) => (
                      <label key={key}>
                        {
                          [
                            'Saldo actual ARS',
                            'Saldo actual USD',
                            'Saldo anterior ARS',
                            'Saldo anterior USD',
                          ][i]
                        }
                        <MoneyField
                          label={key}
                          value={doc[key]}
                          onChange={(n) => update({ ...doc, [key]: n })}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="st-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Persona</th>
                          <th>Consumos ARS segun banco</th>
                          <th>Consumos USD segun banco</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {doc.holders.map((h, i) => (
                          <tr key={i}>
                            <td>
                              <input
                                className="st-input"
                                aria-label={`Persona ${i + 1}`}
                                value={h.holder}
                                onChange={(e) => {
                                  const name = e.target.value;
                                  update({
                                    ...doc,
                                    holders: doc.holders.map((v, j) =>
                                      j === i ? { ...v, holder: name } : v,
                                    ),
                                    lines: doc.lines.map((l) => ({
                                      ...l,
                                      holder: l.holder === h.holder ? name : l.holder,
                                      allocations: l.allocations.map((a) =>
                                        a.holder === h.holder ? { ...a, holder: name } : a,
                                      ),
                                    })),
                                  });
                                }}
                              />
                            </td>
                            <td>
                              <MoneyField
                                label={`Subtotal pesos ${h.holder}`}
                                value={h.statedArsMinor}
                                onChange={(n) =>
                                  update({
                                    ...doc,
                                    holders: doc.holders.map((v, j) =>
                                      j === i ? { ...v, statedArsMinor: n } : v,
                                    ),
                                  })
                                }
                              />
                            </td>
                            <td>
                              <MoneyField
                                label={`Subtotal dolares ${h.holder}`}
                                value={h.statedUsdCents}
                                onChange={(n) =>
                                  update({
                                    ...doc,
                                    holders: doc.holders.map((v, j) =>
                                      j === i ? { ...v, statedUsdCents: n } : v,
                                    ),
                                  })
                                }
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                className="st-icon"
                                title="Eliminar persona"
                                onClick={() =>
                                  update({ ...doc, holders: doc.holders.filter((_, j) => j !== i) })
                                }
                              >
                                <Trash2 size={17} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost st-command"
                    onClick={() =>
                      update({
                        ...doc,
                        holders: [
                          ...doc.holders,
                          {
                            holder: `Persona ${doc.holders.length + 1}`,
                            statedArsMinor: 0,
                            statedUsdCents: 0,
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={16} />
                    Persona
                  </button>
                </details>
              )}
              <div className="st-totals">
                <div>
                  <small>Saldo banco ARS</small>
                  <strong>{money(doc.balanceArsMinor)}</strong>
                </div>
                <div>
                  <small>Saldo banco USD</small>
                  <strong>{money(doc.balanceUsdCents, 'USD')}</strong>
                </div>
                <div>
                  <small>Cargos sin asignar</small>
                  <strong>{summary.pending}</strong>
                </div>
              </div>
              {editable && (
                <div className="st-validation">
                  {doc.extractionWarnings.map((w, i) => (
                    <p key={i} className="st-warning">
                      {w}
                    </p>
                  ))}
                  {summary.errors.map((e) => (
                    <p key={e} className="st-error">
                      {e}
                    </p>
                  ))}
                  {(summary.diffArs !== 0 || summary.diffUsd !== 0) && (
                    <p>
                      Diferencia: {money(summary.diffArs)} / {money(summary.diffUsd, 'USD')}
                    </p>
                  )}
                </div>
              )}
              <div className="st-tabs" role="tablist" aria-label="Detalle del resumen">
                {[
                  ['personas', 'Por persona'],
                  ['movimientos', 'Movimientos'],
                  ['pagos', 'Pagos y asumidos'],
                ].map(([id, name]) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    type="button"
                    onClick={() => setTab(id)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              {tab === 'personas' && (
                <>
                  <StatementSummary rows={rows} editable={!!editable} onSettlement={setEntry} />
                  {!!summary.pending && (
                    <p className="st-warning">
                      Liquidacion incompleta: hay {summary.pending} movimientos pendientes.
                    </p>
                  )}
                  <h2>Impuestos, adelantos y ajustes</h2>
                  <div className="st-charge-list">
                    {doc.lines
                      .filter((l) => l.kind !== 'consumo' && l.kind !== 'pago')
                      .map((l) => (
                        <div key={l.id}>
                          <span>
                            <strong>{l.description}</strong>
                            <small>
                              {l.taxBaseMinor !== null
                                ? `Base: ${money(l.taxBaseMinor, l.currency)} · `
                                : ''}
                              {l.treatment === 'pending'
                                ? 'Sin asignar'
                                : l.treatment === 'excluded'
                                  ? `Excluido: ${l.reason}`
                                  : l.allocations
                                      .map(
                                        (a) => `${a.holder}: ${money(a.amountMinor, l.currency)}`,
                                      )
                                      .join(' / ')}
                            </small>
                          </span>
                          <strong>{money(l.amountMinor, l.currency)}</strong>
                          {editable && (
                            <button
                              type="button"
                              className="st-icon"
                              title={`Repartir ${l.description}`}
                              onClick={() => setAllocation(l)}
                            >
                              <Split size={19} />
                            </button>
                          )}
                        </div>
                      ))}
                  </div>
                </>
              )}
              {tab === 'movimientos' && (
                <>
                  <label className="st-filter">
                    Persona
                    <select
                      className="st-input"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="">Todas / cargos generales</option>
                      <option value="__charges">Cargos generales</option>
                      {doc.holders.map((h) => (
                        <option key={h.holder}>{h.holder}</option>
                      ))}
                    </select>
                  </label>
                  <div className="st-table-wrap">
                    <table className="st-lines">
                      <thead>
                        <tr>
                          <th>Fecha compra</th>
                          <th>Persona</th>
                          <th>Detalle / cuota</th>
                          <th>Tipo</th>
                          <th>Moneda</th>
                          <th>Importe</th>
                          <th>Reparto</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {doc.lines
                          .filter(
                            (l) =>
                              !filter || (filter === '__charges' ? !l.holder : l.holder === filter),
                          )
                          .map((l) => (
                            <tr key={l.id}>
                              <td>
                                <input
                                  className="st-input"
                                  type="date"
                                  aria-label={`Fecha ${l.description}`}
                                  value={l.date}
                                  disabled={!editable}
                                  onChange={(e) => lineChange({ ...l, date: e.target.value })}
                                />
                              </td>
                              <td>
                                <select
                                  className="st-input"
                                  aria-label={`Persona de ${l.description}`}
                                  disabled={!editable}
                                  value={l.holder ?? ''}
                                  onChange={(e) =>
                                    lineChange({
                                      ...l,
                                      holder: e.target.value || null,
                                      ...(l.kind === 'consumo'
                                        ? {
                                            allocations: e.target.value
                                              ? [
                                                  {
                                                    holder: e.target.value,
                                                    amountMinor: l.amountMinor,
                                                  },
                                                ]
                                              : [],
                                            treatment: e.target.value ? 'allocate' : 'pending',
                                          }
                                        : {}),
                                    })
                                  }
                                >
                                  <option value="">General</option>
                                  {doc.holders.map((h) => (
                                    <option key={h.holder}>{h.holder}</option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <input
                                  className="st-input"
                                  aria-label="Detalle"
                                  disabled={!editable}
                                  value={l.description}
                                  onChange={(e) =>
                                    lineChange({ ...l, description: e.target.value })
                                  }
                                />
                                {l.installment && (
                                  <small>
                                    Cuota {l.installment.n}/{l.installment.of}
                                  </small>
                                )}
                              </td>
                              <td>
                                <select
                                  className="st-input"
                                  aria-label="Tipo de movimiento"
                                  disabled={!editable}
                                  value={l.kind}
                                  onChange={(e) =>
                                    lineChange({
                                      ...l,
                                      kind: e.target.value as LedgerLine['kind'],
                                      treatment: 'pending',
                                      allocations: [],
                                      reason: '',
                                    })
                                  }
                                >
                                  {Object.entries(kindNames).map(([key, label]) => (
                                    <option key={key} value={key}>
                                      {label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <select
                                  className="st-input"
                                  aria-label="Moneda"
                                  disabled={!editable}
                                  value={l.currency}
                                  onChange={(e) =>
                                    lineChange({ ...l, currency: e.target.value as 'ARS' | 'USD' })
                                  }
                                >
                                  <option>ARS</option>
                                  <option>USD</option>
                                </select>
                              </td>
                              <td>
                                <MoneyField
                                  disabled={!editable}
                                  label={`Importe ${l.description}`}
                                  value={l.amountMinor}
                                  onChange={(n) =>
                                    lineChange({
                                      ...l,
                                      amountMinor: n,
                                      allocations:
                                        l.allocations.length === 1
                                          ? [{ ...l.allocations[0], amountMinor: n }]
                                          : l.allocations,
                                    })
                                  }
                                />
                              </td>
                              <td>
                                <button
                                  type="button"
                                  disabled={!editable}
                                  className="btn-ghost"
                                  onClick={() => setAllocation(l)}
                                >
                                  {l.treatment === 'pending'
                                    ? 'Pendiente'
                                    : l.treatment === 'excluded'
                                      ? 'Excluido'
                                      : 'Asignado'}
                                </button>
                              </td>
                              <td>
                                {editable && (
                                  <button
                                    type="button"
                                    className="st-icon"
                                    title="Eliminar movimiento"
                                    onClick={() => {
                                      if (confirm('¿Eliminar este renglon de la lectura?'))
                                        update({
                                          ...doc,
                                          lines: doc.lines.filter((v) => v.id !== l.id),
                                        });
                                    }}
                                  >
                                    <Trash2 size={17} />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  {editable && (
                    <button
                      type="button"
                      className="btn-ghost st-command"
                      onClick={() =>
                        update({
                          ...doc,
                          lines: [
                            ...doc.lines,
                            {
                              id: crypto.randomUUID(),
                              kind: 'desconocido',
                              holder: null,
                              date: doc.closeDate,
                              description: '',
                              amountMinor: 0,
                              currency: 'ARS',
                              coupon: null,
                              installment: null,
                              original: null,
                              taxBaseMinor: null,
                              treatment: 'pending',
                              reason: '',
                              allocations: [],
                            },
                          ],
                        })
                      }
                    >
                      <Plus size={17} />
                      Movimiento
                    </button>
                  )}
                </>
              )}
              {tab === 'pagos' && (
                <div className="st-charge-list">
                  {!record.settlements.length && (
                    <p className="st-empty">Sin pagos ni importes asumidos.</p>
                  )}
                  {record.settlements.map((s) => (
                    <div key={s.id}>
                      <span>
                        <strong>{s.holder}</strong>
                        <small>
                          {dateLabel(s.date)} ·{' '}
                          {s.kind === 'payment' ? 'Pago recibido' : 'Asumido por mi'} · {s.note}
                        </small>
                      </span>
                      <strong>{money(s.amountMinor, s.currency)}</strong>
                      <button
                        type="button"
                        className="st-icon"
                        title="Anular registro"
                        onClick={() => {
                          if (
                            confirm('¿Anular este registro? El importe volvera al saldo pendiente.')
                          )
                            void act('Anulando registro...', async () => {
                              accept(await statements.removeSettlement(record.id, s.id));
                              await load();
                            });
                        }}
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {editable && (
                <footer className="st-save">
                  <label className="st-check">
                    <input
                      type="checkbox"
                      checked={doc.reviewConfirmed}
                      onChange={(e) => {
                        setRecord({
                          ...record,
                          document: { ...doc, reviewConfirmed: e.target.checked },
                        });
                        setDirty(true);
                      }}
                    />
                    Revise importes, personas y exclusiones contra el resumen
                  </label>
                  <div>
                    <button type="submit" className="btn-ghost st-command">
                      <Save size={17} />
                      Guardar borrador
                    </button>
                    <button
                      type="button"
                      className="btn-primary st-command"
                      disabled={
                        !!summary.errors.length || !!summary.pending || !doc.reviewConfirmed
                      }
                      onClick={() => void save(true)}
                    >
                      <Check size={17} />
                      Confirmar liquidacion
                    </button>
                  </div>
                </footer>
              )}
              {!editable && (
                <button
                  type="button"
                  className="btn-ghost st-command st-print"
                  onClick={() => window.print()}
                >
                  <Printer size={18} />
                  Imprimir
                </button>
              )}
            </fieldset>
          </form>
          {editable && (
            <details className="st-details st-source">
              <summary>Texto extraido / corregir lectura</summary>
              <textarea
                aria-label="Texto extraido del PDF"
                className="st-input"
                rows={14}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <button
                disabled={!!busy || !text}
                className="btn-ghost"
                onClick={() => {
                  if (
                    confirm('Se reemplazaran los movimientos y repartos del borrador. ¿Continuar?')
                  )
                    void act('Analizando texto...', async () => {
                      const parsed = await statements.parse(text);
                      update({
                        ...parsed,
                        accountId: doc.accountId,
                        dollarPayment: doc.dollarPayment,
                      });
                    });
                }}
              >
                Volver a analizar texto
              </button>
            </details>
          )}
          {allocation && (
            <AllocationEditor
              line={allocation}
              doc={doc}
              onClose={() => setAllocation(null)}
              onSave={(l) => {
                lineChange(l);
                setAllocation(null);
              }}
            />
          )}
          {entry && (
            <div className="st-overlay">
              <section
                className="st-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Registrar cancelacion"
              >
                <h2>{entry.holder}</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act('Registrando...', async () => {
                      accept(await statements.settle(record.id, entry));
                      setEntry(null);
                      await load();
                    });
                  }}
                >
                  <fieldset disabled={!!busy}>
                    <label>
                      Tipo
                      <select
                        className="st-input"
                        value={entry.kind}
                        onChange={(e) =>
                          setEntry({ ...entry, kind: e.target.value as Settlement['kind'] })
                        }
                      >
                        <option value="payment">Pago recibido</option>
                        <option value="assumed">Asumido por mi</option>
                      </select>
                    </label>
                    <label>
                      Importe {entry.currency}
                      <MoneyField
                        value={entry.amountMinor}
                        label="Importe a registrar"
                        onChange={(n) => setEntry({ ...entry, amountMinor: n })}
                      />
                    </label>
                    <label>
                      Fecha
                      <input
                        className="st-input"
                        type="date"
                        required
                        value={entry.date}
                        onChange={(e) => setEntry({ ...entry, date: e.target.value })}
                      />
                    </label>
                    <label>
                      Referencia / motivo
                      <input
                        className="st-input"
                        required
                        maxLength={300}
                        value={entry.note}
                        onChange={(e) => setEntry({ ...entry, note: e.target.value })}
                      />
                    </label>
                    {error && (
                      <p className="st-error" role="alert">
                        {error}
                      </p>
                    )}
                    <footer>
                      <button type="button" className="btn-ghost" onClick={() => setEntry(null)}>
                        Cancelar
                      </button>
                      <button className="btn-primary">
                        {busy ? 'Registrando...' : 'Registrar'}
                      </button>
                    </footer>
                  </fieldset>
                </form>
              </section>
            </div>
          )}
        </>
      )}
    </main>
  );
}
