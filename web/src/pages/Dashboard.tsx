import { useState } from 'react';
import { Link } from 'react-router-dom';
import ConsumptionSummary from '../components/ConsumptionSummary';
import Installments from '../components/Installments';
import { currentPeriod,periodLabel,shiftPeriod } from '../lib/format';
export default function Dashboard() {
 const [period,setPeriod]=useState(currentPeriod());
 return <div className="space-y-3 p-3">
  <header className="flex items-center justify-between px-1 pt-2">
   <button className="rounded-lg px-3 py-1 text-xl" aria-label="Mes anterior" onClick={()=>setPeriod(shiftPeriod(period,1))}>‹</button>
   <h1 className="text-lg font-bold capitalize">{periodLabel(period)}</h1>
   <button className="rounded-lg px-3 py-1 text-xl" aria-label="Mes siguiente" onClick={()=>setPeriod(shiftPeriod(period,-1))}>›</button>
  </header>
  <ConsumptionSummary period={period}/>
  <Installments period={period}/>
  <div className="grid grid-cols-2 gap-3"><Link className="card" to="/ahorros">Ahorros y cuentas →</Link><Link className="card" to="/eventos">Eventos →</Link></div>
 </div>;
}