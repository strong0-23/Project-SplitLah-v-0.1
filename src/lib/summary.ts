import { formatMoney } from "./money";
import type { BillCalculation, Receipt } from "./types";

/** Plain-text breakdown suitable for WhatsApp / Telegram. */
export function summaryText(r: Receipt, calc: BillCalculation): string {
  const t = calc.totals;
  const out: string[] = [];
  out.push(`🧾 ${r.merchant.trim() || "Bill"} — split with Splitlah`);
  out.push(`Total: ${formatMoney(t.totalCents)}`);
  if (t.unroundedTotalCents !== undefined) out.push(`Before bill rounding: ${formatMoney(t.unroundedTotalCents)}; rounding: ${formatMoney(t.roundingCents ?? 0)}`);
  out.push("");
  for (const p of calc.participants) {
    out.push(`${p.name || "Unnamed"}: ${formatMoney(p.owedCents)}`);
    for (const it of p.items) out.push(`  • ${it.description}${it.note ? ` (${it.note})` : ""}: ${formatMoney(it.cents)}`);
    const parts = [`items ${formatMoney(p.itemSubtotalCents)}`];
    if (p.discountCents) parts.push(`discount -${formatMoney(p.discountCents)}`);
    if (p.serviceCents) parts.push(`service ${formatMoney(p.serviceCents)}`);
    if (p.gstAddedCents) parts.push(`GST ${formatMoney(p.gstAddedCents)}`);
    if (p.gstIncludedCents) parts.push(`incl. GST ${formatMoney(p.gstIncludedCents)}`);
    if (p.roundingCents) parts.push(`bill rounding ${formatMoney(p.roundingCents)}`);
    out.push(`  ${parts.join(" · ")}`);
    out.push("");
  }
  return out.join("\n").trim();
}
