import {useState} from 'react';
import ConsumptionSummary from '../components/ConsumptionSummary';
import {currentPeriod} from '../lib/format';
export default function Hormiga(){ const [period,setPeriod]=useState(currentPeriod());return <div className="space-y-3 p-3"><h1 className="text-xl font-bold">Compras que se repiten</h1><label className="block">Mes<input className="input mt-1" type="month" value={period} onChange={e=>{if(e.target.value)setPeriod(e.target.value);}}/></label><ConsumptionSummary period={period} initialView="repeated"/></div>;}
