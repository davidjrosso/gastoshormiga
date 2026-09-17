import { sqlite } from '../src/db/index.js';
import { detectHormiga, detectSubscriptions, monthlySummary, categoryTrends } from '../src/analytics/hormiga.js';
import { savingsSummary, accountBalances } from '../src/analytics/savings.js';
import { formatMinor, todayISO } from '../src/lib/money.js';

const household = sqlite.prepare(`SELECT id, name FROM households LIMIT 1`).get() as { id: string; name: string };
console.log(`\nHogar: ${household.name}\n`);

const period = todayISO().slice(0, 7);

console.log('== RESUMEN DEL MES ==========================================');
const s = monthlySummary(household.id, period);
console.log(`  Ingresos      ${formatMinor(s.incomeMinor)}`);
console.log(`  Gastos        ${formatMinor(s.expenseMinor)}`);
console.log(`    fijos       ${formatMinor(s.fixedExpenseMinor)}`);
console.log(`    variables   ${formatMinor(s.variableExpenseMinor)}`);
console.log(`  Balance       ${formatMinor(s.balanceMinor)}   (tasa de ahorro: ${s.savingsRatePct}%)`);
if (s.expenseUsdCents) console.log(`  Gasto en USD  ${formatMinor(s.expenseUsdCents, 'USD')}`);

console.log('\n== GASTO HORMIGA ============================================');
const hormiga = detectHormiga(household.id, 3);
if (hormiga.length === 0) console.log('  (no se detectó nada)');
for (const h of hormiga) {
  console.log(`  ${h.merchantName}`);
  console.log(`     ${h.count} compras · promedio ${formatMinor(h.avgMinor)} · ${h.timesPerMonth}/mes`);
  console.log(`     ${formatMinor(h.monthlyAvgMinor)} por mes  ->  ${formatMinor(h.annualizedMinor)} al año`);
  if (h.annualizedUsdCents) console.log(`     equivale a ${formatMinor(h.annualizedUsdCents, 'USD')} al año`);
}

console.log('\n== SUSCRIPCIONES ============================================');
const subs = detectSubscriptions(household.id, 6);
if (subs.length === 0) console.log('  (no se detectó nada)');
for (const sub of subs) {
  const change = sub.priceChangePct != null && sub.priceChangePct !== 0
    ? `  [${sub.priceChangePct > 0 ? '+' : ''}${sub.priceChangePct}% desde el primer cargo]`
    : '';
  console.log(`  ${sub.merchantName}  ${formatMinor(sub.amountMinor)} ${sub.cadence}${change}`);
  console.log(`     ${sub.occurrences} cargos · próximo ~${sub.nextExpectedDate} · ${formatMinor(sub.annualMinor)} al año`);
}

console.log('\n== CATEGORIAS (mes vs promedio previo) ======================');
for (const t of categoryTrends(household.id, period).slice(0, 8)) {
  const delta = t.changePct != null ? `${t.changePct > 0 ? '+' : ''}${t.changePct}%` : '—';
  const share = t.shareOfIncomePct != null ? `${t.shareOfIncomePct}% del ingreso` : '';
  console.log(`  ${t.categoryName.padEnd(24)} ${formatMinor(t.currentMinor).padStart(16)}  ${delta.padStart(8)}  ${share}`);
}

console.log('\n== CUENTAS Y AHORRO =========================================');
for (const b of accountBalances(household.id)) {
  console.log(`  ${b.name.padEnd(24)} ${formatMinor(b.balanceMinor, b.currency as 'ARS' | 'USD').padStart(18)}`);
}
const sav = savingsSummary(household.id);
console.log(`  Dólares comprados:   ${formatMinor(sav.usdHeldCents, 'USD')}`);
console.log(`  Pesos invertidos:    ${formatMinor(sav.arsSpentBuyingUsdMinor)}`);
if (sav.avgPurchaseRateMinor) {
  console.log(`  Cotización promedio: ${formatMinor(sav.avgPurchaseRateMinor)} por USD`);
}
console.log('');
