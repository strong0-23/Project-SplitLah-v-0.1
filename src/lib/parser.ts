import { parseMoney, parseRate } from "./money";
import type { Receipt, ReceiptItem } from "./types";
import { newId } from "./ids";
import { emptyReceipt } from "./defaults";

/** Price at the end of a line, e.g. "$7.80", "S$ 12.50", "3,60", "-2.00". */
const PRICE_AT_END = /(-?)\s*S?\$?\s*(\d{1,6}(?:,\d{3})*\s?[.,]\s?\d{2})\s*-?\s*[A-Z]?\s*$/i;

/**
 * Per-item tax markers printed after a product name, e.g. "NAAN(GST*)", "(GST)", "(T)", "*".
 * OCR often renders "*" as "#", "+", "x", "¥" or "%". These mark the ITEM as taxable; they are not
 * tax lines, so they're stripped before the line is classified.
 */
const ITEM_TAX_MARKER = /\s*[([{]\s*(?:GST|BST|6ST|VAT|SR|T|ZR)\s*[*#+x×¥%&]?\s*[)\]}]?\s*$/i;

/**
 * Summary labels are matched against the WHOLE label (anchored), never as substrings, so product
 * names such as "BUTTER CHICKEN B.LESS" or "TAX-FREE COLA" are never misread as charges.
 */
const L = {
  subtotal: /^(?:sub\s*-?\s*total|subttl|sales\s*(?:amount|amt|total)|net\s*sales|nett?\s*sub\s*-?\s*total|food\s*total|total\s*before\s*(?:tax|gst))\b/i,
  service: /^(?:service(?:\s*charge|\s*chg)?|svc(?:\s*chg)?|s\/?c|svr\s*chg|sc)\b/i,
  tax: /^(?:total\s*)?(?:gst|vat|tax)\b|^(?:incl(?:usive|\.)?\s*(?:of\s*)?)?(?:gst|vat)\b/i,
  discount: /^(?:disc(?:ount)?|less\b|promo(?:tion)?|voucher|member\s*disc|coupon)/i,
  payment: /^(?:cash|change|visa|master\s*card|mastercard|amex|nets|pay\s*now|paylah|grab\s*pay|card|credit|debit|paid|payment|tender(?:ed)?|balance(?!\s*due)|rounding|round\s*adj)/i,
  total: /^(?:grand\s*total|total(?:\s*(?:amount|amt|due|payable|sgd|s\$))?|nett?\s*(?:amount|total)|amount(?:\s*(?:due|payable))?|balance\s*due)\s*:?$/i,
  /** Count lines such as "Total QTY 10" — never a monetary total. */
  count: /^(?:total\s*)?(?:qty|quantity|items?|pax|no\.?\s*of\s*items)\b/i,
  itemHeader: /\b(?:product|item|description|desc)\b.*\b(?:qty|quantity|total|amount|price|amt)\b/i,
  inclusiveNote: /\b(?:incl(?:usive|udes?|uded|\.)?)\b.*\b(?:gst|vat|tax)\b|\b(?:gst|vat|tax)\b.*\bincl(?:usive|uded|\.)?\b/i,
};

/** Header lines that are never the merchant name. */
const NOT_MERCHANT = /^(?:table|tbl|final\s*receipt|receipt|tax\s*invoice|invoice|bill|order|cashier|waiter|server|date|time|tel|phone|gst\s*reg|uen|copy|reprint|welcome|thank)/i;

export interface ParseResult {
  receipt: Receipt;
  warnings: string[];
}

function money(raw: string): number | null {
  const s = raw.replace(/\s/g, "").replace(/,(\d{2})$/, ".$1").replace(/,/g, "");
  return parseMoney(s);
}

/** Normalise a label for summary matching: drop leading OCR noise and trailing colons. */
function cleanLabel(label: string): string {
  return label.replace(/^[^A-Za-z0-9$]+/, "").replace(/[\s:.\-_]+$/, "").trim();
}

function isWordy(l: string): boolean {
  const letters = (l.match(/[a-z]/gi) ?? []).length;
  return letters >= 3 && letters / l.replace(/\s/g, "").length > 0.6;
}

interface ItemSplit { desc: string; quantity: number; qtyUncertain: boolean; taxMarked: boolean }

/** Separates description, item tax marker and a leading OR trailing quantity column. */
export function splitItemLabel(label: string): ItemSplit {
  let desc = label.trim();
  let quantity = 1;
  let qtyUncertain = false;
  // Trailing Qty column: "CHEESE BUTTER NAAN(GST*) 2". OCR may read "1" as I, l, | or !.
  const trail = /^(.*?[A-Za-z)\]*#+])\s+(\d{1,2}|[Il|!])$/.exec(desc);
  if (trail) {
    const raw = trail[2] ?? "1";
    quantity = /\d/.test(raw) ? Number(raw) : 1;
    qtyUncertain = !/\d/.test(raw);
    desc = trail[1] ?? desc;
  } else {
    // Leading quantity: "2 x Foo", "2x Foo", "2 Foo".
    const lead = /^(\d{1,2})\s*[x×*]?\s+(.+)$/i.exec(desc) ?? /^(\d{1,2})\s*[x×*]\s*(.+)$/i.exec(desc);
    if (lead && Number(lead[1]) > 0) { quantity = Number(lead[1]); desc = lead[2] ?? desc; }
  }
  if (quantity < 1) { quantity = 1; qtyUncertain = true; }
  // Drop a trailing unit price ("Coffee 2 @ 3.50") — we keep only the line total.
  desc = desc.replace(/\s*@\s*\$?\d+[.,]\d{2}\s*$/, "");
  let taxMarked = false;
  if (ITEM_TAX_MARKER.test(desc)) { taxMarked = true; desc = desc.replace(ITEM_TAX_MARKER, ""); }
  desc = desc.replace(/[^\p{L}\p{N}&'()./+\- ]/gu, "").replace(/\s+/g, " ").trim();
  return { desc, quantity, qtyUncertain, taxMarked };
}

type Section = "header" | "items" | "summary";

/** Pure parser: turns raw OCR text into a draft receipt. Never invents prices. */
export function parseReceiptText(text: string): ParseResult {
  const r = emptyReceipt();
  r.rawOcrText = text;
  const warnings: string[] = [];
  const uncertain = new Set<string>();
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const hasItemHeader = lines.some((l) => L.itemHeader.test(l) && !PRICE_AT_END.test(l));

  // Merchant: first wordy, unpriced line in the top section that isn't a known heading.
  for (const l of lines.slice(0, 8)) {
    if (PRICE_AT_END.test(l) || L.itemHeader.test(l)) break;
    const c = cleanLabel(l);
    if (NOT_MERCHANT.test(c) || !isWordy(c)) continue;
    r.merchant = c.slice(0, 60);
    break;
  }
  if (!r.merchant) uncertain.add("merchant");

  let serviceAmt: number | null = null;
  let taxAmt: number | null = null;
  let anyTaxMarked = false;
  const items: ReceiptItem[] = [];
  const skipped: string[] = [];
  let section: Section = hasItemHeader ? "header" : "items";

  for (const line of lines) {
    if (L.inclusiveNote.test(line) && !PRICE_AT_END.test(line)) r.gstInclusive = true;
    if (section === "header" && L.itemHeader.test(line) && !PRICE_AT_END.test(line)) { section = "items"; continue; }

    const m = PRICE_AT_END.exec(line);
    const rawLabel = m ? line.slice(0, m.index).trim() : line;
    const label = cleanLabel(rawLabel);

    if (L.count.test(label)) continue; // "Total QTY 10" — a count, never money.

    if (!m) {
      // Item-section lines that lost their price: keep them (flagged) instead of dropping silently.
      if (section === "items" && hasItemHeader && !/^[-=_.\s]+$/.test(line)) {
        const s = splitItemLabel(label);
        const letters = (s.desc.match(/\p{L}/gu) ?? []).length;
        if (letters >= 3 && (s.taxMarked || /\s\d{1,2}$/.test(label))) {
          if (s.taxMarked) anyTaxMarked = true;
          items.push({ id: newId("i"), description: s.desc.slice(0, 80), quantity: s.quantity, lineTotalCents: null, flagged: true });
        }
      }
      continue;
    }

    const amount = money(m[2] ?? "");
    if (amount === null) { skipped.push(line); continue; }
    const negative = m[1] === "-" || /-\s*$/.test(line);

    if (L.subtotal.test(label)) { r.printedSubtotalCents = amount; section = "summary"; continue; }
    if (L.service.test(label)) {
      serviceAmt = amount; section = "summary";
      const rate = /(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(label);
      if (rate) { const bp = parseRate(rate[1] ?? ""); if (bp !== null) r.serviceRateBp = bp; }
      continue;
    }
    if (L.tax.test(label) && !ITEM_TAX_MARKER.test(label)) {
      taxAmt = amount; section = "summary";
      if (L.inclusiveNote.test(label)) r.gstInclusive = true;
      const rate = /(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(label);
      if (rate) { const bp = parseRate(rate[1] ?? ""); if (bp !== null) r.gstRateBp = bp; }
      continue;
    }
    if (L.payment.test(label)) { section = "summary"; continue; }
    if (L.discount.test(label) || negative) { r.discountCents += amount; continue; }
    if (L.total.test(label)) { if (r.receiptTotalCents === null) r.receiptTotalCents = amount; section = "summary"; continue; }

    if (section === "summary") { skipped.push(line); continue; }

    const s = splitItemLabel(label);
    const letters = (s.desc.match(/\p{L}/gu) ?? []).length;
    if (letters < 2) { skipped.push(line); continue; }
    if (s.taxMarked) anyTaxMarked = true;
    const flagged = s.qtyUncertain || letters < 4 || /[|{}[\]]/.test(rawLabel);
    items.push({ id: newId("i"), description: s.desc.slice(0, 80), quantity: s.quantity, lineTotalCents: amount, flagged });
  }

  r.items = items;
  if (items.length === 0) warnings.push("No purchased items were recognised. Add them manually.");
  const missing = items.filter((i) => i.lineTotalCents === null).length;
  if (missing) warnings.push(`${missing} item line(s) were read without a price — enter the line total for highlighted items.`);
  if (items.some((i) => i.flagged && i.lineTotalCents !== null)) warnings.push("Some item lines look uncertain — please check highlighted lines.");
  if (skipped.length) warnings.push(`Lines not used: ${skipped.slice(0, 4).map((s) => `“${s.slice(0, 40)}”`).join(", ")}${skipped.length > 4 ? "…" : ""}`);

  const sum = items.reduce((s, i) => s + (i.lineTotalCents ?? 0), 0);
  reconcileCharges(r, { sum, serviceAmt, taxAmt, anyTaxMarked, complete: missing === 0 }, warnings, uncertain);

  if (r.receiptTotalCents === null) { uncertain.add("total"); warnings.push("Receipt total not found — enter it to check the maths."); }
  r.uncertainFields = [...uncertain];
  r.ocrWarnings = warnings.slice(0, 20).map((w) => w.slice(0, 300));
  return { receipt: r, warnings };
}

const fmt = (c: number) => (c / 100).toFixed(2);

/**
 * Decides whether printed tax is ADDED on top of item prices or already INCLUDED, using the printed
 * numbers only (a per-item "(GST*)" marker alone does not imply either). Ambiguity is flagged.
 */
function reconcileCharges(
  r: Receipt,
  { sum, serviceAmt, taxAmt, anyTaxMarked, complete }: { sum: number; serviceAmt: number | null; taxAmt: number | null; anyTaxMarked: boolean; complete: boolean },
  warnings: string[],
  uncertain: Set<string>,
) {
  const sub = r.printedSubtotalCents;
  const total = r.receiptTotalCents;
  const svc = serviceAmt ?? 0;

  if (serviceAmt === null && taxAmt === null) {
    r.serviceEnabled = false;
    r.gstEnabled = false;
    uncertain.add("charges");
    warnings.push(anyTaxMarked
      ? "Items are marked as GST items but no tax amount was found. Check whether prices include GST."
      : "No service charge or GST lines were found. Turn them on if the receipt has them.");
    if (complete && sub !== null && sub !== sum) {
      uncertain.add("items");
      warnings.push(`Items add up to ${fmt(sum)} but the printed subtotal is ${fmt(sub)}. Some lines may be missing or misread.`);
    }
    return;
  }

  r.chargeMode = "receipt";
  r.serviceEnabled = serviceAmt !== null;
  r.serviceAmountCents = serviceAmt;
  r.gstEnabled = taxAmt !== null;
  r.gstAmountCents = taxAmt;
  const tax = taxAmt ?? 0;

  // Evidence for each interpretation, from printed numbers only.
  const inclusiveEvidence =
    (sub !== null && taxAmt !== null && sub + svc + tax === sum && sub !== sum) ||
    (sub === null && total !== null && taxAmt !== null && total === sum + svc && tax > 0);
  const exclusiveEvidence =
    (sub !== null && sub === sum && (total === null || total === sub + svc + tax)) ||
    (sub === null && total !== null && total === sum + svc + tax);

  if (inclusiveEvidence && !exclusiveEvidence && r.gstEnabled) {
    r.gstInclusive = true;
    // Printed subtotal is the pre-tax (net) figure; keep it separate from the GST-inclusive item sum.
    r.printedNetSubtotalCents = sub;
    r.printedSubtotalCents = null;
    warnings.push(`Prices already include GST: ${sub !== null ? `pre-tax subtotal ${fmt(sub)} + ` : ""}tax ${fmt(tax)} = items ${fmt(sum)}. GST will not be added again.`);
    if (total !== null && total !== sum + svc) uncertain.add("total");
    return;
  }
  if (exclusiveEvidence && !inclusiveEvidence) {
    if (r.gstInclusive) {
      // A printed "incl. GST" note contradicts the arithmetic.
      r.gstInclusive = false;
      uncertain.add("charges");
      warnings.push("The receipt mentions GST included, but its numbers show GST added on top. Please confirm.");
    }
    return;
  }

  // Neither (or both) interpretations fit the printed numbers exactly.
  uncertain.add("charges");
  if (complete) uncertain.add("items");
  const parts = [`items ${fmt(sum)}`];
  if (sub !== null) parts.push(`printed subtotal ${fmt(sub)}`);
  if (serviceAmt !== null) parts.push(`service ${fmt(svc)}`);
  if (taxAmt !== null) parts.push(`tax ${fmt(tax)}`);
  if (total !== null) parts.push(`total ${fmt(total)}`);
  warnings.push(`Couldn't tell whether tax is included or added (${parts.join(", ")}). Some numbers may be misread — check them and the “Prices already include GST” switch.`);
  if (sub !== null && sub !== sum) {
    // Keep the printed figure as evidence but don't present it as a gross subtotal.
    r.printedNetSubtotalCents = sub;
    r.printedSubtotalCents = null;
  }
}

/** Higher = more internally consistent parse. Used to pick between OCR passes. */
export function scoreParse(r: Receipt): number {
  const priced = r.items.filter((i) => i.lineTotalCents !== null);
  const sum = priced.reduce((s, i) => s + (i.lineTotalCents ?? 0), 0);
  let score = priced.length * 2 - (r.items.length - priced.length) * 2 - r.items.filter((i) => i.flagged).length;
  if (r.receiptTotalCents !== null) score += 2;
  const svc = r.serviceEnabled ? r.serviceAmountCents ?? 0 : 0;
  const tax = r.gstEnabled ? r.gstAmountCents ?? 0 : 0;
  const expected = sum - r.discountCents + svc + (r.gstInclusive ? 0 : tax);
  if (priced.length && r.receiptTotalCents === expected) score += 10;
  if (!r.uncertainFields?.includes("charges")) score += 4;
  if (!r.uncertainFields?.includes("items")) score += 2;
  return score;
}

