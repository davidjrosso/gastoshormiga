import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRefresh } from '../App';
import { ApiError, api, type Account, type ImportPlan, type PlannedMovement } from '../lib/api';
import { money, moneyShort } from '../lib/format';
import { pdfATexto } from '../lib/pdf';

/**
 * Importar el resumen de la tarjeta.
 *
 * La pantalla entera está construida alrededor de una idea: nada entra sin que
 * lo veas. Importar ochenta renglones a ciegas es la forma más rápida de
 * ensuciar una base que después nadie limpia, así que primero se muestra qué
 * va a pasar con cada uno y recién después se confirma.
 *
 * El PDF no se sube: el texto se extrae en tu propio dispositivo y al servidor
 * viaja solo eso.
 */

const ETIQUETA: Record<string, string> = {
  consumo: 'Compra',
  pago: 'Pago de la tarjeta',
  adelanto: 'Adelanto',
  percepcion_recuperable: 'Percepción 30% (vuelve)',
  credito_percepcion: 'Devolución del 30%',
  impuesto: 'Impuesto',
  interes: 'Interés',
  desconocido: 'Sin clasificar',
};

export default function Importar() {
  const { bump } = useRefresh();
  const [cuentas, setCuentas] = useState<Account[]>([]);
  const [tarjetaId, setTarjetaId] = useState('');
  const [bancoId, setBancoId] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [texto, setTexto] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState('');
  const [listo, setListo] = useState<{ importados: number; cierre: string } | null>(null);
  const [verTodo, setVerTodo] = useState(false);

  useEffect(() => {
    api.accounts().then((a) => {
      setCuentas(a);
      setTarjetaId(a.find((x) => x.type === 'tarjeta')?.accountId ?? '');
      setBancoId(a.find((x) => x.type === 'banco')?.accountId ?? '');
    }).catch(() => setError('No se pudieron cargar las cuentas'));
  }, []);

  const cuerpo = useMemo(() => ({
    bank: 'bbva', text: texto, accountId: tarjetaId,
    paymentAccountId: bancoId || null, advanceAccountId: bancoId || null,
  }), [texto, tarjetaId, bancoId]);

  async function elegirArchivo(file: File) {
    setError(null); setPlan(null); setListo(null);
    setCargando('Leyendo el PDF en tu dispositivo…');
    try {
      const t = await pdfATexto(file);
      setTexto(t);
      setCargando('Analizando el resumen…');
      setPlan(await api.importPreview({ ...cuerpo, text: t }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo leer el resumen');
    } finally {
      setCargando('');
    }
  }

  async function confirmar() {
    setError(null); setCargando('Importando…');
    try {
      const r = await api.importConfirm(cuerpo);
      setListo({ importados: r.importados, cierre: r.cierre });
      setPlan(null);
      bump();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo importar');
    } finally {
      setCargando('');
    }
  }

  const visibles = plan
    ? (verTodo ? plan.movements : plan.movements.filter((m) => m.status !== 'ya_importado'))
    : [];

  return (
    <div className="space-y-3 p-3">
      <header className="px-1 pt-2">
        <Link to="/ajustes" className="text-sm text-ink-mute dark:text-slate-400">‹ Ajustes</Link>
        <h1 className="mt-1 text-lg font-bold">Importar resumen</h1>
        <p className="text-sm text-ink-mute dark:text-slate-400">
          El PDF se lee en tu dispositivo. No se sube a ningún lado.
        </p>
      </header>

      {listo && (
        <div className="card bg-emerald-50 ring-emerald-200 dark:bg-emerald-950 dark:ring-emerald-900">
          <p className="font-semibold text-emerald-800 dark:text-emerald-200">
            Se importaron {listo.importados} movimientos
          </p>
          <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-300">
            Cierre del {listo.cierre}. Podés revisarlos en Movimientos.
          </p>
        </div>
      )}

      {!plan && (
        <div className="card space-y-3">
          <div>
            <label className="label" htmlFor="tarjeta">Qué tarjeta</label>
            <select id="tarjeta" className="input mt-1" value={tarjetaId}
                    onChange={(e) => setTarjetaId(e.target.value)}>
              {cuentas.filter((c) => c.type === 'tarjeta').map((c) => (
                <option key={c.accountId} value={c.accountId}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="banco">De qué cuenta la pagás</label>
            <select id="banco" className="input mt-1" value={bancoId}
                    onChange={(e) => setBancoId(e.target.value)}>
              <option value="">No importar los pagos</option>
              {cuentas.filter((c) => c.type !== 'tarjeta').map((c) => (
                <option key={c.accountId} value={c.accountId}>{c.name}</option>
              ))}
            </select>
            <p className="mt-2 text-xs text-ink-mute dark:text-slate-400">
              Pagar la tarjeta no es un gasto: la plata se mueve de tu cuenta a la
              tarjeta. Sin indicar de dónde sale, esos renglones no se importan.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="pdf">El resumen en PDF</label>
            <input id="pdf" type="file" accept="application/pdf" className="input mt-1"
                   disabled={!tarjetaId || !!cargando}
                   onChange={(e) => e.target.files?.[0] && elegirArchivo(e.target.files[0])} />
          </div>
          {!tarjetaId && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Primero creá una cuenta de tipo tarjeta en Ajustes.
            </p>
          )}
        </div>
      )}

      {cargando && <p className="p-4 text-ink-mute dark:text-slate-400">{cargando}</p>}

      {error && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {plan && (
        <>
          <div className="card">
            <p className="label">{plan.statement.card} ···{plan.statement.accountTail}</p>
            <p className="mt-1 text-sm text-ink-soft dark:text-slate-300">
              Cierre {plan.statement.closeDate} · vence {plan.statement.dueDate}
            </p>

            {/* La verificación es la que autoriza a importar. Si no cierra,
                algo se perdió al leer el PDF y no sabemos qué. */}
            {plan.statement.check.ok ? (
              <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                ✓ El resumen cierra al centavo contra sus propios totales.
              </p>
            ) : (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                El resumen no cierra: faltan {money(Math.abs(plan.statement.check.diffArsMinor))}.
                No se puede importar hasta entender qué se perdió al leerlo.
              </p>
            )}
          </div>

          {/* Cuando no hay nada nuevo, mostrar "Gasto real del período: $0"
              es engañoso: el período tuvo gasto, lo que pasa es que ya está
              cargado. Son dos mensajes distintos y conviene no mezclarlos. */}
          {plan.summary.nuevos === 0 ? (
            <div className="card">
              <p className="font-medium">Este resumen ya está importado.</p>
              <p className="mt-1 text-sm text-ink-mute dark:text-slate-400">
                Los {plan.summary.yaImportados} renglones ya están en la app. No hay nada
                para agregar y nada se va a duplicar.
              </p>
            </div>
          ) : (
            <div className="card">
              <p className="label">Gasto real del período</p>
              <p className="tabular mt-1 text-3xl font-bold">{money(plan.summary.gastoNuevoMinor)}</p>
              {plan.summary.gastoNuevoUsdCents > 0 && (
                <p className="text-sm text-ink-soft dark:text-slate-300">
                  más {money(plan.summary.gastoNuevoUsdCents, 'USD')} en dólares
                </p>
              )}
              <p className="mt-2 border-t border-slate-200 pt-2 text-sm text-ink-mute dark:border-slate-800 dark:text-slate-400">
                El banco te cobra <strong className="tabular">{moneyShort(plan.statement.balanceArsMinor)}</strong>,
                pero no todo es gasto: los pagos, los adelantos y la percepción del 30%
                son plata que cambia de lugar.
              </p>
              {plan.summary.percepcionRecuperableMinor > 0 && (
                <p className="mt-2 text-sm text-ink-soft dark:text-slate-300">
                  Quedan <strong className="tabular">{money(plan.summary.percepcionRecuperableMinor)}</strong> en
                  percepciones que ARCA devuelve el mes que viene si pagás el saldo en dólares.
                </p>
              )}
            </div>
          )}

          {plan.statement.holders.length > 1 && (
            <div className="card">
              <p className="label mb-2">Consumos por titular</p>
              {plan.statement.holders.map((h) => (
                <div key={h.holder} className="flex justify-between py-1 text-sm">
                  <span className="truncate">{h.holder}</span>
                  <span className="tabular shrink-0 font-medium">
                    {money(h.statedArsMinor, 'ARS', false)}
                    {h.statedUsdCents > 0 && <> · {money(h.statedUsdCents, 'USD')}</>}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between px-1 pt-2">
            <h2 className="text-base font-bold">
              {plan.summary.nuevos} para importar
            </h2>
            {plan.summary.yaImportados > 0 && (
              <button className="text-sm text-ink-mute underline dark:text-slate-400"
                      onClick={() => setVerTodo(!verTodo)}>
                {verTodo ? 'ocultar' : `ver ${plan.summary.yaImportados} ya importados`}
              </button>
            )}
          </div>

          {plan.summary.yaImportados > 0 && !verTodo && (
            <p className="px-1 text-sm text-ink-mute dark:text-slate-400">
              {plan.summary.yaImportados} renglones ya estaban en la app y no se van a duplicar.
            </p>
          )}

          <div className="card divide-y divide-slate-100 p-0 dark:divide-slate-800">
            {visibles.map((m) => <Renglon key={m.fingerprint} m={m} />)}
          </div>

          <div className="sticky bottom-0 flex gap-2 bg-slate-100 py-3 dark:bg-slate-950">
            <button className="btn-ghost flex-1" onClick={() => { setPlan(null); setTexto(''); }}>
              Cancelar
            </button>
            <button className="btn-primary flex-[2]"
                    disabled={!!cargando || !plan.statement.check.ok || plan.summary.nuevos === 0}
                    onClick={confirmar}>
              Importar {plan.summary.nuevos}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Renglon({ m }: { m: PlannedMovement }) {
  const esTransferencia = m.movement?.type === 'transferencia';
  return (
    <div className={`flex items-start gap-3 p-3 ${m.status !== 'nuevo' ? 'opacity-45' : ''}`}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{m.line.description || ETIQUETA[m.line.kind]}</p>
        <p className="truncate text-xs text-ink-mute dark:text-slate-400">
          {m.line.date}
          {m.line.holder && <> · {m.line.holder}</>}
          {m.line.installment && <> · cuota {m.line.installment.n}/{m.line.installment.of}</>}
          {m.line.original && <> · {m.line.original.code} {m.line.original.amount}</>}
        </p>
        <p className="mt-0.5 text-xs">
          <span className={esTransferencia
            ? 'text-sky-700 dark:text-sky-400'
            : 'text-ink-mute dark:text-slate-400'}>
            {ETIQUETA[m.line.kind] ?? m.line.kind}
            {esTransferencia && ' · no cuenta como gasto'}
          </span>
          {m.status === 'ya_importado' && <span className="ml-1 text-ink-mute">· ya importado</span>}
          {m.reason && <span className="ml-1 text-amber-700 dark:text-amber-500">· {m.reason}</span>}
        </p>
      </div>
      <p className="tabular shrink-0 text-sm font-semibold">
        {money(Math.abs(m.line.amountMinor), m.line.currency, false)}
      </p>
    </div>
  );
}
