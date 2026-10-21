import { useEffect, useId, useState } from 'react';
import { api, type Category, type ExpenseDetails } from '../lib/api';
import { amountForInput, money } from '../lib/format';

export const emptyExpense = (): ExpenseDetails => ({concept:'',recipient:'Hogar',categoryId:null,quantity:null,unit:'',reviewed:true,parts:[]});
export function inputMinor(value: string) {
  let s=value.trim().replace(/\s|\$/g,'');
  if(s.includes(',')) s=s.replace(/\./g,'').replace(',','.');
  else if(/^\d{1,3}(\.\d{3})+$/.test(s)) s=s.replace(/\./g,'');
  return /^\d+(\.\d{0,2})?$/.test(s) ? Math.round(Number(s)*100) : 0;
}
function PartAmount({value,onChange}:{value:number;onChange:(n:number)=>void}) {
  const [text,setText]=useState(value ? amountForInput(value) : '');
  useEffect(()=>{setText(current=>inputMinor(current)===value?current:value?amountForInput(value):'');},[value]);
  return <input aria-label="Importe del detalle" className="input" inputMode="decimal" placeholder="Importe" value={text}
    onChange={e=>{setText(e.target.value);onChange(inputMinor(e.target.value));}} />;
}
export default function ExpenseFields({value,onChange,categories,amount,currency='ARS'}:{
  value:ExpenseDetails;onChange:(v:ExpenseDetails)=>void;categories:Category[];amount:string;currency?:'ARS'|'USD';
}) {
  const id=useId();
  const [added,setAdded]=useState<Category[]>([]);
  const [categoryName,setCategoryName]=useState('');
  const [categoryError,setCategoryError]=useState('');
  const [categoryBusy,setCategoryBusy]=useState(false);
  const [options,setOptions]=useState<{concepts:{concept:string;categoryId:string|null}[];recipients:string[]}>({concepts:[],recipients:['Hogar']});
  useEffect(()=>{let active=true;api.expenseOptions().then(r=>{if(active)setOptions(r);}).catch(()=>{});return()=>{active=false;};},[]);
  const change=(patch:Partial<ExpenseDetails>)=>onChange({...value,...patch});
  async function createCategory() {
    setCategoryBusy(true);setCategoryError('');
    try {const c=await api.createCategory({name:categoryName.trim(),kind:'gasto',isFixed:false,color:'#64748b',icon:'•'});setAdded(rows=>[...rows,c]);change({categoryId:c.id});setCategoryName('');}
    catch(e){setCategoryError(e instanceof Error?e.message:'No se pudo crear la categoría.');}finally{setCategoryBusy(false);}
  }
  const choices=[...categories,...added].filter((c,i,all)=>c.kind==='gasto'&&all.findIndex(x=>x.id===c.id)===i).sort((a,b)=>a.name.localeCompare(b.name,'es'));
  const selectCategory=(selected:string|null,set:(v:string|null)=>void)=><select aria-label="Categoría del consumo" className="input" value={selected??''} onChange={e=>set(e.target.value||null)}>
    <option value="">Sin categoría · revisar después</option>{choices.filter(c=>c.id===selected||!/^Hij[oa]\s|\bFlor$/i.test(c.name)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>;
  const total=value.parts.reduce((s,p)=>s+p.amountMinor,0);
  return <div className="card mt-3 space-y-3">
    <label className="block font-semibold" htmlFor={`${id}-concept`}>¿Qué compraste o pagaste?</label>
    <input id={`${id}-concept`} className="input" list={`${id}-concepts`} placeholder="Carne, gimnasio, alquiler…" maxLength={160} value={value.concept}
      onChange={e=>{const suggestion=options.concepts.find(c=>c.concept.toLocaleLowerCase()===e.target.value.toLocaleLowerCase());change({concept:e.target.value,...(suggestion?{categoryId:suggestion.categoryId}:{})});}} />
    <datalist id={`${id}-concepts`}>{options.concepts.map(c=><option key={c.concept} value={c.concept}/>)}</datalist>
    <label className="block text-sm" htmlFor={`${id}-recipient`}>Para quién es <span className="text-ink-mute">(independiente de quién pagó)</span></label>
    <input id={`${id}-recipient`} className="input" maxLength={160} list={`${id}-people`} placeholder="Hogar, una persona…" value={value.recipient} onChange={e=>change({recipient:e.target.value})}/>
    <datalist id={`${id}-people`}>{options.recipients.map(p=><option key={p} value={p}/>)}</datalist>
    {selectCategory(value.categoryId,categoryId=>change({categoryId}))}
    <details><summary className="cursor-pointer text-sm">Crear categoría</summary><p className="my-2 text-xs text-ink-mute">Usá un rubro como Alimentos, Limpieza o Actividad física. Las personas van en “Para quién”.</p><input aria-label="Nueva categoría" className="input" maxLength={80} value={categoryName} onChange={e=>setCategoryName(e.target.value)}/><button className="btn-ghost mt-2" type="button" disabled={categoryBusy||!categoryName.trim()} onClick={createCategory}>Crear y seleccionar</button>{categoryError&&<p role="alert" className="text-sm text-red-600">{categoryError}</p>}</details>
    <details><summary className="cursor-pointer text-sm">Cantidad y unidad (opcional)</summary><div className="mt-2 grid grid-cols-2 gap-2">
      <input aria-label="Cantidad" className="input" type="number" min="0.001" step="any" value={value.quantity??''} onChange={e=>change({quantity:e.target.value?Number(e.target.value):null})}/>
      <input aria-label="Unidad" className="input" placeholder="kg, litros, unidades" maxLength={30} value={value.unit} onChange={e=>change({unit:e.target.value})}/>
    </div></details>
    <details open={value.parts.length>0 || undefined}><summary className="cursor-pointer text-sm">Dividir esta compra (opcional)</summary>
      <p className="my-2 text-xs text-ink-mute">Los detalles reparten el total; no generan gastos nuevos. Si no sabés los importes, dejá la compra sin desglosar.</p>
      {value.parts.map((p,index)=><div key={index} className="my-2 space-y-2 rounded-xl border p-3">
        <input aria-label={`Concepto ${index+1}`} className="input" placeholder="Alimentos, limpieza…" maxLength={160} value={p.concept} onChange={e=>change({parts:value.parts.map((v,i)=>i===index?{...v,concept:e.target.value}:v)})}/>
        <PartAmount value={p.amountMinor} onChange={amountMinor=>change({parts:value.parts.map((v,i)=>i===index?{...v,amountMinor}:v)})}/>
        {selectCategory(p.categoryId,categoryId=>change({parts:value.parts.map((v,i)=>i===index?{...v,categoryId}:v)}))}
        <input aria-label={`Destinatario ${index+1}`} className="input" list={`${id}-people`} placeholder="Para quién" maxLength={160} value={p.recipient} onChange={e=>change({parts:value.parts.map((v,i)=>i===index?{...v,recipient:e.target.value}:v)})}/>
        <button type="button" className="text-sm underline" onClick={()=>change({parts:value.parts.filter((_,i)=>i!==index)})}>Quitar detalle</button>
      </div>)}
      <button type="button" className="btn-ghost mt-2" disabled={value.parts.length>=50} onClick={()=>change({parts:[...value.parts,{concept:'',recipient:value.recipient,categoryId:value.categoryId,amountMinor:0,quantity:null,unit:''}]})}>Agregar detalle</button>
      {value.parts.length>0&&<p role="status" className={`mt-2 text-sm ${total===inputMinor(amount)&&value.parts.length>=2?'text-emerald-600':'text-red-600'}`}>Desglosado: {money(total,currency)} / {money(inputMinor(amount),currency)}. Mínimo dos detalles.</p>}
    </details>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={value.reviewed} onChange={e=>change({reviewed:e.target.checked})}/>Revisé el concepto y la clasificación</label>
  </div>;
}
