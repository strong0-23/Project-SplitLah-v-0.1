/**
 * Receipt parser: OCR lines → draft `Receipt`. Pure; never invents prices.
 *
 * Works as a small state machine over sections (header → items → summary → footer) using:
 *   ./numbers   locale-aware amounts and currency
 *   ./lexicon   what each label means
 *   ./items     how an item row is laid out
 *   ./reconcile whether the printed numbers agree
 * Anything it can't place is kept visible: flagged items, null prices or a "Lines not used" warning.
 */
import { newId } from "../ids";
import { emptyReceipt } from "../defaults";
import type { Receipt, ReceiptItem } from "../types";
import { readItemRow, letterCount, splitItemLabel } from "./items";
import {
  classifyLabel,
  INCLUSIVE_NOTE,
  ITEM_HEADER,
  MODIFIER,
  NOT_MERCHANT,
  type LineKind,
} from "./lexicon";
import {
  detectCurrency,
  detectFormat,
  findAmounts,
  findRateBp,
  type Amount,
  type NumberFormat,
} from "./numbers";
import { fmt, reconcileCharges } from "./reconcile";

export { scoreParse, isConsistent } from "./reconcile";
export { splitItemLabel } from "./items";

export interface ParseResult {
  receipt: Receipt;
  warnings: string[];
  /** ISO code detected from the receipt, null if none printed. */
  currency: string | null;
}

type Section = "header" | "items" | "summary" | "footer";
const SUMMARY: ReadonlySet<LineKind> = new Set([
  "subtotal",
  "service",
  "tax",
  "discount",
  "rounding",
  "total",
]);
const MAX_ROUNDING = 5; // cents; cash rounding beyond this is treated as a misread

/** Collapses runs of spaces but keeps a two-space column gap. */
export function normaliseLine(l: string): string {
  return l
    .replace(/\t/g, "  ")
    .split(/ {2,}/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("  ");
}

/** Drops leading OCR noise and trailing separators from a label. */
export function cleanLabel(label: string): string {
  return label
    .replace(/^[^\p{L}\p{N}$+>]+/u, "")
    .replace(/[\s:.\-_=]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isWordy(l: string): boolean {
  const letters = letterCount(l);
  return letters >= 3 && letters / l.replace(/\s/g, "").length > 0.6;
}

interface Line {
  text: string;
  amounts: Amount[];
  rawLabel: string;
  label: string;
  kind: LineKind | null;
}

function readLine(text: string, nf: NumberFormat): Line {
  const amounts = findAmounts(text, nf);
  const rawLabel = amounts.length ? text.slice(0, amounts[0]!.start).trim() : text;
  const label = cleanLabel(rawLabel);
  return { text, amounts, rawLabel, label, kind: classifyLabel(label) };
}

/** A row with an amount but no description of its own ("2 @ 3.50   7.00", "  7.00"). */
const isDetailRow = (l: Line | undefined) =>
  !!l && l.amounts.length > 0 && l.kind === null && letterCount(splitItemLabel(l.label).desc) < 2;

const appendNote = (item: ReceiptItem, note: string) => {
  const n = note.replace(/^[+>~•·*\-\s]+/, "").trim();
  if (n) item.description = `${item.description} (${n})`.slice(0, 80);
};

export function parseReceiptText(text: string): ParseResult {
  return parseReceiptLines(text.split(/\r?\n/), text);
}

export function parseReceiptLines(rawLines: string[], rawText = rawLines.join("\n")): ParseResult {
  const r = emptyReceipt();
  r.rawOcrText = rawText.slice(0, 20000);
  const warnings: string[] = [];
  const uncertain = new Set<string>();

  const texts = rawLines.map(normaliseLine).filter(Boolean);
  const currency = detectCurrency(texts);
  const nf = detectFormat(texts, currency);
  const lines = texts.map((t) => readLine(t, nf));
  const hasItemHeader = lines.some((l) => ITEM_HEADER.test(l.text) && !l.amounts.length);

  // Merchant: first wordy, unpriced line in the top section that isn't a known heading.
  for (const l of lines.slice(0, 8)) {
    if (l.amounts.length || ITEM_HEADER.test(l.text)) break;
    if (NOT_MERCHANT.test(l.label) || l.kind === "noise" || !isWordy(l.label)) continue;
    r.merchant = l.label.slice(0, 60);
    break;
  }
  if (!r.merchant) uncertain.add("merchant");

  const items: ReceiptItem[] = [];
  const skipped: string[] = [];
  const totals: number[] = [];
  const taxParts: Array<{ cents: number; isTotal: boolean }> = [];
  const lineDiscounts: Array<{ item: ReceiptItem; cents: number; desc: string }> = [];
  let serviceAmt: number | null = null;
  let rounding: number | null = null;
  let totalsBeforeRounding = 0;
  let anyTaxMarked = false;
  let subtotalSeen = false;
  let pendingName: string | null = null;
  let pendingKind: LineKind | null = null;
  let section: Section = hasItemHeader ? "header" : "items";
  const last = () => items[items.length - 1];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (INCLUSIVE_NOTE.test(l.text) && !l.amounts.length) r.gstInclusive = true;
    if (section === "header" && ITEM_HEADER.test(l.text) && !l.amounts.length) {
      section = "items";
      continue;
    }
    if (l.kind === "noise" || l.kind === "count" || l.kind === "info") {
      pendingKind = null;
      continue;
    }
    if (/^[-=_*.~#\s]+$/.test(l.text)) continue;

    // ---- Lines without an amount ----------------------------------------------------------
    if (!l.amounts.length) {
      if (l.kind && SUMMARY.has(l.kind)) {
        pendingKind = l.kind;
        continue;
      } // amount on the next line
      if (l.kind === "payment") {
        if (totals.length) section = "footer";
        continue;
      }
      if (section !== "items") continue;
      const s = splitItemLabel(l.label);
      if (letterCount(s.desc) < 2) continue;
      if (isDetailRow(lines[i + 1])) {
        pendingName = l.label;
        continue;
      }
      if (MODIFIER.test(l.label) && last()) {
        appendNote(last()!, l.label);
        continue;
      }
      if (s.taxMarked || (hasItemHeader && /\s\d{1,2}$/.test(l.label))) {
        // An item row whose price was lost by OCR: keep it, flagged, instead of dropping it.
        if (s.taxMarked) anyTaxMarked = true;
        items.push({
          id: newId("i"),
          description: s.desc.slice(0, 80),
          quantity: s.quantity,
          lineTotalCents: null,
          flagged: true,
        });
        continue;
      }
      // Wrapped description or unpriced note under the previous item.
      if (last() && letterCount(s.desc) >= 3 && s.desc.length <= 40) appendNote(last()!, s.desc);
      continue;
    }

    // ---- Lines with an amount ---------------------------------------------------------------
    const amt = l.amounts[l.amounts.length - 1]!;
    let kind = l.kind;
    if (pendingKind && !kind && letterCount(l.label) < 2) kind = pendingKind;
    pendingKind = null;

    // A free option under an item ("- Less sugar 0.00") is a note, not a discount or a new item.
    if (amt.cents === 0 && (kind === null || kind === "discount") && section === "items") {
      if (last()) appendNote(last()!, l.label);
      continue;
    }

    switch (kind) {
      case "subtotal":
        if (!subtotalSeen) r.printedSubtotalCents = amt.cents;
        subtotalSeen = true;
        section = "summary";
        continue;
      case "service": {
        serviceAmt = (serviceAmt ?? 0) + amt.cents;
        const bp = findRateBp(l.label);
        if (bp !== null) r.serviceRateBp = bp;
        section = "summary";
        continue;
      }
      case "tax": {
        taxParts.push({ cents: amt.cents, isTotal: /\b(?:total|amount|amt)\b/i.test(l.label) });
        if (INCLUSIVE_NOTE.test(l.text) || /^incl/i.test(l.label)) r.gstInclusive = true;
        const bp = findRateBp(l.label);
        if (bp !== null) r.gstRateBp = bp;
        section = "summary";
        continue;
      }
      case "discount":
        addDiscount(amt.cents, l.label);
        continue;
      case "rounding":
        if (amt.cents === 0) continue;
        if (amt.cents <= MAX_ROUNDING) {
          rounding = amt.negative ? -amt.cents : amt.cents;
          totalsBeforeRounding = totals.length;
        } else skipped.push(l.text);
        continue;
      case "total":
        if (section !== "footer") totals.push(amt.cents);
        section = section === "footer" ? "footer" : "summary";
        continue;
      case "payment":
        if (totals.length) section = "footer";
        continue;
      default:
        break;
    }

    if (section === "footer") continue;
    if (amt.negative && section !== "header") {
      addDiscount(amt.cents, l.label);
      continue;
    }
    if (section === "summary" || section === "header") {
      skipped.push(l.text);
      continue;
    }

    const row = readItemRow(l.text, l.amounts, l.rawLabel.replace(/^[^\p{L}\p{N}(+>]+/u, ""));
    if (letterCount(row.desc) < 2) {
      if (!pendingName) {
        skipped.push(l.text);
        continue;
      }
      const s = splitItemLabel(pendingName);
      row.desc = s.desc.slice(0, 80);
      row.taxMarked ||= s.taxMarked;
      row.uncertain = row.uncertain && letterCount(s.desc) < 4;
      if (s.quantity > 1 && row.quantity === 1) row.quantity = s.quantity;
    }
    pendingName = null;
    if (row.taxMarked) anyTaxMarked = true;

    const prev = last();
    if (prev && (MODIFIER.test(l.label) || amt.cents === 0)) {
      // Add-on or free option: it belongs to whoever had the item above it.
      if (prev.lineTotalCents !== null) prev.lineTotalCents += amt.cents;
      appendNote(prev, amt.cents ? `${l.label} ${fmt(amt.cents)}` : l.label);
      continue;
    }
    if (amt.cents === 0) continue;
    items.push({
      id: newId("i"),
      description: row.desc,
      quantity: row.quantity,
      lineTotalCents: row.lineTotalCents,
      flagged: row.uncertain,
    });
  }

  function addDiscount(cents: number, label: string) {
    const prev = items[items.length - 1];
    // A discount printed right under an item, before any subtotal, belongs to that item.
    if (
      section === "items" &&
      !subtotalSeen &&
      prev &&
      prev.lineTotalCents !== null &&
      cents <= prev.lineTotalCents
    ) {
      prev.lineTotalCents -= cents;
      lineDiscounts.push({ item: prev, cents, desc: prev.description });
      appendNote(prev, `${label || "discount"} -${fmt(cents)}`);
      return;
    }
    r.discountCents += cents;
  }

  r.items = items;
  let sum = items.reduce((s, it) => s + (it.lineTotalCents ?? 0), 0);

  // If the printed subtotal is the pre-discount figure, treat item discounts as a bill discount.
  const lineDisc = lineDiscounts.reduce((s, d) => s + d.cents, 0);
  if (
    lineDisc &&
    r.printedSubtotalCents !== null &&
    r.printedSubtotalCents === sum + lineDisc &&
    r.printedSubtotalCents !== sum
  ) {
    for (const d of lineDiscounts) {
      d.item.lineTotalCents! += d.cents;
      d.item.description = d.desc;
    }
    r.discountCents += lineDisc;
    sum += lineDisc;
  }

  // Total: the last one printed before payment; with cash rounding, the figure before rounding.
  if (rounding !== null && totals.length) {
    r.receiptTotalCents =
      totalsBeforeRounding > 0
        ? totals[totalsBeforeRounding - 1]!
        : totals[totals.length - 1]! - rounding;
    warnings.push(
      `The shop rounded the payable amount by ${fmt(rounding)}. Splitting uses the unrounded total ${fmt(r.receiptTotalCents)}.`,
    );
  } else if (totals.length) {
    r.receiptTotalCents = totals[totals.length - 1]!;
  }

  // Tax: a printed tax total wins; identical repeats count once; separate taxes add up.
  let taxAmt: number | null = null;
  if (taxParts.length) {
    const t = [...taxParts].reverse().find((p) => p.isTotal);
    taxAmt = t
      ? t.cents
      : taxParts.every((p) => p.cents === taxParts[0]!.cents)
        ? taxParts[0]!.cents
        : taxParts.reduce((s, p) => s + p.cents, 0);
  }

  if (items.length === 0) warnings.push("No purchased items were recognised. Add them manually.");
  const missing = items.filter((it) => it.lineTotalCents === null).length;
  if (missing)
    warnings.push(
      `${missing} item line(s) were read without a price — enter the line total for highlighted items.`,
    );
  if (items.some((it) => it.flagged && it.lineTotalCents !== null))
    warnings.push("Some item lines look uncertain — please check highlighted lines.");
  if (skipped.length)
    warnings.push(
      `Lines not used: ${skipped
        .slice(0, 4)
        .map((s) => `“${s.slice(0, 40)}”`)
        .join(", ")}${skipped.length > 4 ? "…" : ""}`,
    );
  if (currency.code && currency.code !== "SGD") {
    warnings.push(
      `This receipt looks like it's in ${currency.code}. Amounts are kept as printed${currency.minorDigits === 0 ? " (shown with .00)" : ""}; the app labels them SGD.`,
    );
  }

  reconcileCharges(
    r,
    { sum, serviceAmt, taxAmt, anyTaxMarked, complete: missing === 0 },
    warnings,
    uncertain,
  );

  if (r.receiptTotalCents === null) {
    uncertain.add("total");
    warnings.push("Receipt total not found — enter it to check the maths.");
  }
  r.uncertainFields = [...uncertain];
  r.ocrWarnings = warnings.slice(0, 20).map((w) => w.slice(0, 300));
  return { receipt: r, warnings, currency: currency.code };
}
