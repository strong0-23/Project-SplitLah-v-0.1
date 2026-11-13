/**
 * Cross-checks the parsed receipt against its own printed numbers. Pure.
 * Decides whether tax is added on top or already included, and scores how consistent a parse is
 * (used to choose between OCR passes). Never invents amounts; ambiguity is flagged for the user.
 */
import { computeTotals } from "../bill";
import { applyRate, formatRate, includedTax } from "../money";
import type { Receipt } from "../types";

export const fmt = (c: number) => `${c < 0 ? "-" : ""}${(Math.abs(c) / 100).toFixed(2)}`;

/** Cash rounding of up to 5 cents (D4); a larger difference is a misread, not rounding. */
export const MAX_ROUNDING = 5;

/**
 * D17: the printed total disagrees with the items and charges that were read, by more than D4's
 * cash rounding, under either tax reading (tax added on top, or already in the prices). With item
 * prices missing, only the prices that were read are known, so it disagrees only when they (with
 * the charges, less the discount) already come to more than the total. A missing price is never
 * guessed. Returns the amount the total was compared with, or null when the total agrees (or none
 * was read). Pure; uses the receipt's own charge fields, so it can run after `reconcileCharges`.
 */
export function totalDisagreement(r: Receipt): { readCents: number; complete: boolean } | null {
  const total = r.receiptTotalCents;
  if (total === null) return null;
  const priced = r.items.filter((i) => i.lineTotalCents !== null);
  const complete = priced.length === r.items.length;
  const sum = priced.reduce((s, i) => s + (i.lineTotalCents ?? 0), 0);
  const svc = r.serviceEnabled ? (r.serviceAmountCents ?? 0) : 0;
  const tax = r.gstEnabled ? (r.gstAmountCents ?? 0) : 0;
  const base = sum - r.discountCents + svc; // tax already in the prices
  if (complete) {
    const near = (v: number) => Math.abs(total - v) <= MAX_ROUNDING;
    return near(base) || near(base + tax) ? null : { readCents: base, complete };
  }
  // Unread prices and the tax can only add to what was read (a missing price is never negative).
  const least = base + Math.min(tax, 0);
  return least > total + MAX_ROUNDING ? { readCents: least, complete } : null;
}

export interface ChargeEvidence {
  sum: number;
  serviceAmt: number | null;
  taxAmt: number | null;
  anyTaxMarked: boolean;
  /** Every item line has a price. */
  complete: boolean;
}

/**
 * Sets charge mode/flags from printed service and tax lines and the subtotal/total arithmetic.
 * A per-item "(GST*)" marker alone never implies inclusive or exclusive tax.
 */
export function reconcileCharges(
  r: Receipt,
  ev: ChargeEvidence,
  warnings: string[],
  uncertain: Set<string>,
): void {
  const { sum, serviceAmt, taxAmt, anyTaxMarked, complete } = ev;
  const sub = r.printedSubtotalCents;
  const total = r.receiptTotalCents;
  const svc = serviceAmt ?? 0;
  const net = sum - r.discountCents;

  if (serviceAmt === null && taxAmt === null) {
    r.serviceEnabled = false;
    r.gstEnabled = false;
    // A plain receipt whose items already add up to the total has no hidden charges.
    if (total !== null && complete && total === net) return;
    uncertain.add("charges");
    warnings.push(
      anyTaxMarked || r.gstInclusive
        ? "Items are marked as taxed but no tax amount was found. Check whether prices include tax."
        : "No service charge or tax lines were found. Turn them on if the receipt has them.",
    );
    if (complete && sub !== null && sub !== sum && sub !== net) {
      uncertain.add("items");
      warnings.push(
        `Items add up to ${fmt(sum)} but the printed subtotal is ${fmt(sub)}. Some lines may be missing or misread.`,
      );
    }
    return;
  }

  r.chargeMode = "receipt";
  r.serviceEnabled = serviceAmt !== null;
  r.serviceAmountCents = serviceAmt;
  r.gstEnabled = taxAmt !== null;
  r.gstAmountCents = taxAmt;
  const tax = taxAmt ?? 0;
  const subOk = (v: number) => v === sum || v === net;

  // Evidence for each interpretation, from printed numbers only.
  const inclusiveEvidence =
    (sub !== null &&
      taxAmt !== null &&
      (sub + svc + tax === sum || sub + svc + tax === net) &&
      !subOk(sub)) ||
    (sub === null && total !== null && taxAmt !== null && total === net + svc && tax > 0) ||
    (sub !== null &&
      subOk(sub) &&
      total !== null &&
      taxAmt !== null &&
      tax > 0 &&
      total === net + svc &&
      total !== net + svc + tax);
  const exclusiveEvidence =
    (sub !== null && subOk(sub) && (total === null || total === net + svc + tax)) ||
    (sub === null && total !== null && total === net + svc + tax);

  if (inclusiveEvidence && !exclusiveEvidence && r.gstEnabled) {
    r.gstInclusive = true;
    if (sub !== null && !subOk(sub)) {
      // Printed subtotal is the pre-tax (net) figure; keep it apart from the tax-inclusive item sum.
      r.printedNetSubtotalCents = sub;
      r.printedSubtotalCents = null;
    }
    warnings.push(
      `Prices already include tax: tax ${fmt(tax)} is part of the item prices and will not be added again.`,
    );
    if (total !== null && total !== net + svc) uncertain.add("total");
    return;
  }
  if (exclusiveEvidence && !inclusiveEvidence) {
    if (r.gstInclusive) {
      r.gstInclusive = false; // a printed "incl. GST" note contradicts the arithmetic
      uncertain.add("charges");
      warnings.push(
        "The receipt mentions tax included, but its numbers show tax added on top. Please confirm.",
      );
    }
    return;
  }

  // Neither (or both) interpretations fit the printed numbers exactly.
  uncertain.add("charges");
  if (complete) uncertain.add("items");
  const parts = [`items ${fmt(sum)}`];
  if (r.discountCents) parts.push(`discount ${fmt(r.discountCents)}`);
  if (sub !== null) parts.push(`printed subtotal ${fmt(sub)}`);
  if (serviceAmt !== null) parts.push(`service ${fmt(svc)}`);
  if (taxAmt !== null) parts.push(`tax ${fmt(tax)}`);
  if (total !== null) parts.push(`total ${fmt(total)}`);
  warnings.push(
    `Couldn't tell whether tax is included or added (${parts.join(", ")}). Some numbers may be misread — check them and the “Prices already include GST” switch.`,
  );
  if (sub !== null && !subOk(sub)) {
    r.printedNetSubtotalCents = sub;
    r.printedSubtotalCents = null;
  }
}

export interface RateEvidence {
  sum: number;
  /** GST/tax rate printed on the tax line, or null. */
  printedTaxRateBp: number | null;
  /** The tax line says "GST" (so Singapore's standard rate applies if none is printed). */
  taxIsGst: boolean;
  /** Exactly one tax amount was printed (several taxes can't be checked against one rate). */
  singleTaxLine: boolean;
  /** Service-charge lines only (no delivery/platform fees, D6), and their printed rate. */
  serviceChargeCents: number | null;
  printedServiceRateBp: number | null;
  /** Rate to assume for a GST line with no printed rate (the app's GST default), or null. */
  defaultGstRateBp: number | null;
}

/**
 * Charge sanity (P5): a printed GST or service amount that differs from rate × base by ANY amount
 * marks the charges uncertain, and the warning shows the expected value. Never auto-corrects.
 * Uses the app's own rate arithmetic (`applyRate`, `includedTax`), so "expected" means what the
 * bill would compute.
 */
export function checkChargeRates(
  r: Receipt,
  ev: RateEvidence,
  warnings: string[],
  uncertain: Set<string>,
): void {
  const net = Math.max(ev.sum - r.discountCents, 0);
  if (ev.serviceChargeCents !== null && ev.printedServiceRateBp !== null) {
    const expected = applyRate(net, ev.printedServiceRateBp);
    if (expected !== ev.serviceChargeCents) {
      uncertain.add("charges");
      warnings.push(
        `Service charge is printed as ${fmt(ev.serviceChargeCents)}, but ${formatRate(ev.printedServiceRateBp)}% of ${fmt(net)} is ${fmt(expected)}. Check the service charge; it was not changed.`,
      );
    }
  }
  const rate = ev.printedTaxRateBp ?? (ev.taxIsGst ? ev.defaultGstRateBp : null);
  if (!r.gstEnabled || r.gstAmountCents === null || !ev.singleTaxLine || rate === null) return;
  const base = net + (r.serviceEnabled ? (r.serviceAmountCents ?? 0) : 0);
  const expected = r.gstInclusive ? includedTax(base, rate) : applyRate(base, rate);
  if (expected === r.gstAmountCents) return;
  uncertain.add("charges");
  warnings.push(
    `GST is printed as ${fmt(r.gstAmountCents)}, but ${formatRate(rate)}% ${r.gstInclusive ? "included in" : "of"} ${fmt(base)} is ${fmt(expected)}. Check the GST amount; it was not changed.`,
  );
}

/** Higher = more internally consistent parse. Used to pick between OCR passes. */
export function scoreParse(r: Receipt): number {
  // A footer-only reading (no item rows) never replaces one with items, even items that still
  // need correcting (parser-v2).
  if (!r.items.length) return Number.NEGATIVE_INFINITY;
  const priced = r.items.filter((i) => i.lineTotalCents !== null);
  const sum = priced.reduce((s, i) => s + (i.lineTotalCents ?? 0), 0);
  let score =
    priced.length * 2 -
    (r.items.length - priced.length) * 2 -
    r.items.filter((i) => i.flagged).length;
  if (r.receiptTotalCents !== null) score += 2;
  const svc = r.serviceEnabled ? (r.serviceAmountCents ?? 0) : 0;
  const tax = r.gstEnabled ? (r.gstAmountCents ?? 0) : 0;
  const expected = sum - r.discountCents + svc + (r.gstInclusive ? 0 : tax);
  if (priced.length && r.receiptTotalCents === expected) score += 10;
  if (!r.uncertainFields?.includes("charges")) score += 4;
  if (!r.uncertainFields?.includes("items")) score += 2;
  return score;
}

/** True when the parse fully reconciles and needs no second OCR pass. */
export function isConsistent(r: Receipt): boolean {
  if (
    !r.items.length ||
    r.receiptTotalCents === null ||
    r.items.some((i) => i.lineTotalCents === null)
  )
    return false;
  if (r.uncertainFields?.some((f) => f === "charges" || f === "items" || f === "total"))
    return false;
  const t = computeTotals(r); // the same arithmetic the bill uses
  return t.ok && t.value.mismatchCents === 0;
}
