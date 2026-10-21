import { useEffect,useState } from 'react';
import { useRefresh } from '../App';
import { api,type ExpenseOverview,type Transaction,type ExpenseItem } from '../lib/api';
import { money,currentPeriod,periodLabel } from '../lib/format';
import EditTransaction from './EditTransaction';

type View='categories'|'concepts'|'recipients'|'payers'|'repeated'|'review';
const titles:Record<View,string>={categories:'En qué se fue',concepts:'Qué compramos',recipients:'Para quién',payers:'Quién pagó',repeated:'Qué se repite',review:'Por revisar'};
const normalize=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
export default function ConsumptionSummary({period,initialView='categories'}:{period:string;initialView?:View}) {
  const [currency,setCurrency]=useState<'ARS'|'USD'>('ARS');
  const [basis,setBasis]=useState<'booked'|'consumed'>('booked');
  const [view,setView]=useState<View>(initialView);
  const [data,setData]=useState<ExpenseOverview|null>(null);
  const [error,setError]=useState('');
  const [expanded,setExpanded]=useState<string|null>(null);
  const [editing,setEditing]=useState<Transaction|null>(null);
  const [loadingEdit,setLoadingEdit]=useState(false);
  const [retry,setRetry]=useState(0);
  const {token,bump}=useRefresh();
  useEffect(()=>{let active=true;setData(null);setError('');setExpanded(null);
    api.expenses(period,currency,basis).then(r=>{if(active)setData(r);}).catch(()=>{if(active)setError('No se pudo cargar el resumen.');});
    return()=>{active=false;};},[period,currency,basis,token,retry]);
  async function edit(id:string) {
    setLoadingEdit(true);setError('');
    try {const [tx]=await api.transactions({id,limit:1});if(!tx)throw Error();setEditing(tx);}
    catch {setError('No se pudo abrir el gasto.');}finally{setLoadingEdit(false);}
  }
  function detail(items:ExpenseItem[]) {
    return <div className="mt-2 divide-y dark:divide-slate-700">{items.map((item,i)=><button key={`${item.transactionId}-${i}`} type="button" disabled={loadingEdit} onClick={()=>edit(item.transactionId)} className="block w-full py-3 text-left text-sm">
      <div className="flex justify-between gap-2"><span className="font-medium break-words">{item.concept}</span><span className="shrink-0 tabular">{money(item.amountMinor,currency)}</span></div>
      <p className="text-xs text-ink-mute">{item.date} · {item.categoryName} · Para {item.recipient} · Pagó {item.paidBy}</p>
      {item.quantity!==null&&<p className="text-xs">{item.quantity} {item.unit}</p>}
      {item.installment&&<p className="text-xs">Cuota {item.installment.n}/{item.installment.of} · Compra {item.purchaseDate}</p>}
      {item.statementId&&<p className="text-xs text-ink-mute break-words">Banco: {item.originalDescription} · Imputado {item.bookedDate}</p>}
      {item.needsReview&&<p className="text-xs text-amber-700 dark:text-amber-300">Revisar concepto, categoría o destinatario →</p>}
    </button>)}</div>;
  }
  const field=view==='categories'?'categoryName':view==='recipients'?'recipient':view==='payers'?'paidBy':'concept';
  return <>
    <section className="card space-y-3">
      <h2 className="text-xl font-bold">Lo que compramos y pagamos</h2>
      <div className="flex flex-wrap gap-2">
        <select className="input w-auto" aria-label="Moneda del resumen" value={currency} onChange={e=>setCurrency(e.target.value as 'ARS'|'USD')}><option value="ARS">Pesos (ARS)</option><option value="USD">Dólares (USD)</option></select>
        <select className="input min-w-0 flex-1" aria-label="Fecha del resumen" value={basis} onChange={e=>setBasis(e.target.value as 'booked'|'consumed')}><option value="booked">Gastos imputados al mes</option><option value="consumed">Consumos por fecha · sin cuotas</option></select>
      </div>
      <p className="text-xs text-ink-mute">{basis==='booked'?'Incluye las cuotas facturadas al cierre, sin sumar otra vez el valor completo de la compra.':'Usa la fecha de compra del banco en consumos sin cuotas. Las cuotas se consultan por mes de cierre; cargos e impuestos conservan su fecha de imputación.'}</p>
      {period===currentPeriod()&&<p className="text-xs font-medium">Mes en curso: datos parciales.</p>}
      {data&&<><p className="text-3xl font-bold tabular">{money(data.totalMinor,currency)}</p><p className="text-sm text-ink-mute">{data.count} gastos · {data.pending} por revisar</p>
        {!!data.excludedInstallments&&<p className="text-sm">{data.excludedInstallments} cuotas de este mes se muestran únicamente en “Gastos imputados al mes”.</p>}</>}
    </section>
    {error&&<div role="alert" className="card text-red-600">{error} <button className="underline" onClick={()=>setRetry(n=>n+1)}>Reintentar</button></div>}
    {!data&&!error&&<p className="p-3">Cargando…</p>}
    {data&&<>
      <section className="card">
        <div className="mb-4 flex flex-wrap gap-2">{(Object.keys(titles) as View[]).map(v=><button key={v} className={`chip ${view===v?'bg-ink text-white dark:bg-white dark:text-ink':'bg-slate-100 dark:bg-slate-800'}`} onClick={()=>{setView(v);setExpanded(null);}} aria-pressed={view===v}>{titles[v]}{v==='review'?` (${data.pending})`:''}</button>)}</div>
        {view==='review'?<><p className="text-sm text-ink-mute">Tocá un gasto para identificarlo. Los datos históricos se conservan; las sugerencias de destinatario necesitan tu revisión.</p>{detail(data.items.filter(i=>i.needsReview))}{data.pending===0&&<p className="py-4">Todo revisado en esta vista.</p>}</>:<>
          {view==='repeated'&&<p className="mb-3 text-sm text-ink-mute">Conceptos con más de un gasto en el período, sin eventos extraordinarios. La frecuencia no implica que sea un gasto innecesario.</p>}
          {data[view].length===0&&<p className="py-3 text-sm text-ink-mute">No hay gastos para mostrar con estos filtros.</p>}
          {data[view].map(g=><div key={g.name} className="border-b py-2 last:border-0 dark:border-slate-700">
            <button className="w-full text-left" onClick={()=>setExpanded(expanded===g.name?null:g.name)} aria-expanded={expanded===g.name}>
              <div className="flex items-baseline justify-between gap-3"><span className="break-words font-medium">{expanded===g.name?'▾':'▸'} {g.name}</span><span className="tabular shrink-0 font-semibold">{money(g.amountMinor,currency)}</span></div>
              <p className="mt-1 text-xs text-ink-mute">{g.count} gastos{data.totalMinor>0?` · ${(g.amountMinor/data.totalMinor*100).toFixed(1)}% del total`:''}</p>
            </button>
            {expanded===g.name&&detail(data.items.filter(i=>normalize(i[field])===normalize(g.name)&&(view!=='repeated'||i.habitual)))}
          </div>)}
        </>}
      </section>
      <details className="card"><summary className="cursor-pointer font-semibold">Cobertura de los datos y comparación</summary>
        <p className="my-2 text-sm">Un mes con registros puede estar incompleto. Los cierres de tarjeta pueden mover consumos entre meses. No calculamos variaciones automáticas entre estas coberturas distintas.</p>
        {data.coverage.map(c=><p key={c.period} className="py-1 text-sm capitalize">{periodLabel(c.period)}: {c.manual} manuales/fijos · {c.card} de tarjeta</p>)}
        <p className="mt-2 text-xs text-ink-mute">Cantidades de movimientos, de ambas monedas, por fecha de imputación.</p>
      </details>
      <details className="card"><summary className="cursor-pointer font-semibold">Ingresos y gastos imputados · por moneda</summary>
        {data.balances.map(b=><div key={b.currency} className="mt-3 text-sm"><strong>{b.currency}</strong><p>Ingresos: {money(b.incomeMinor,b.currency)}</p><p>Gastos: {money(b.expenseMinor,b.currency)}</p><p>Diferencia registrada: {money(b.incomeMinor-b.expenseMinor,b.currency)}</p></div>)}
        <p className="mt-2 text-xs text-ink-mute">No es el saldo bancario. Incluye consumos de tarjeta por cierre; transferencias excluidas.</p>
      </details>
    </>}
    {editing&&<EditTransaction tx={editing} onClose={()=>setEditing(null)} onSaved={bump}/>}
  </>;
}
