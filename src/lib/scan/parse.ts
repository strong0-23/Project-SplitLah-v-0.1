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
import { DEFAULT_GST_BP, emptyReceipt } from "../defaults";
import type { Receipt, ReceiptItem } from "../types";
import { letterCount, NO_QTY_COLUMNS, readItemRow, splitItemLabel, type QtyColumns } from "./items";
import {
  ADDRESS,
  classifyLabel,
  FEE,
  INCLUSIVE_NOTE,
  isFinancialNote,
  ITEM_HEADER,
  MODIFIER,
  NOT_A_NOTE,
  NOT_MERCHANT,
  normaliseLabelWords,
  qtyColumnsOf,
  UNIT_PRICE_HEADER,
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
import { checkChargeRates, fmt, reconcileCharges } from "./reconcile";

export { scoreParse, isConsistent } from "./reconcile";
export { splitItemLabel } from "./items";

/**
 * Start of the scan warning that lists fee lines folded into the service amount (D6). The receipt's
 * `ocrWarnings` carry it, so the review screen can tell without a new stored field.
 */
export const FOLDED_FEES_NOTE = "Delivery/platform fees are included in the service charge:";

/** True when a scanned receipt's service amount includes delivery/platform/packaging fees. */
export function hasFoldedFees(ocrWarnings: readonly string[] | null | undefined): boolean {
  return !!ocrWarnings?.some((w) => w.startsWith(FOLDED_FEES_NOTE));
}

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
const MAX_ROUNDING = 5; // cents; cash rounding beyond this is treated as a misread (D4)

/**
 * Collapses runs of spaces but keeps a two-space column gap. A "|" with space (or the line edge)
 * on both sides is a column separator; a "|" touching a digit is left for OCR digit repair.
 */
export function normaliseLine(l: string): string {
  return l
    .replace(/\t/g, "  ")
    .replace(/(^|\s)[|¦](?=\s|$)/g, "$1  ")
    .split(/ {2,}/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("  ");
}

/** Drops leading OCR noise and trailing separators (incl. stray "|", "©", ";") from a label. */
export function cleanLabel(label: string): string {
  return label
    .replace(/^[^\p{L}\p{N}$+>]+/u, "")
    .replace(/[\s:;.\-_=|©]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A description that stops on a joining word or comma continues on the next line. */
const OPEN_END = /(?:[,&+/]|\b(?:with|and|of|w\/|dan|dengan|und|mit|et|avec|con|met))$/i;

function isWordy(l: string): boolean {
  const letters = letterCount(l);
  return letters >= 3 && letters / l.replace(/\s/g, "").length > 0.6;
}

interface Line {
  text: string;
  amounts: Amount[];
  rawLabel: string;
  label: string;
  /** `label` after the finite OCR word repair, for vocabulary checks only. */
  words: string;
  kind: LineKind | null;
}

function readLine(text: string, nf: NumberFormat): Line {
  const amounts = findAmounts(text, nf);
  const rawLabel = amounts.length ? text.slice(0, amounts[0]!.start).trim() : text;
  const label = cleanLabel(rawLabel);
  // OCR label repair runs before trailing noise is stripped, so "T0TA|" is still "total".
  const words = cleanLabel(normaliseLabelWords(rawLabel));
  return {
    text,
    amounts,
    rawLabel,
    label,
    words,
    kind: classifyLabel(label) ?? classifyLabel(words),
  };
}

/** A row with an amount but no description of its own ("2 @ 3.50   7.00"). */
const isDetailRow = (l: Line | undefined) =>
  !!l && l.amounts.length > 0 && l.kind === null && letterCount(splitItemLabel(l.label).desc) < 2;

/** Mostly digits (dates, reference numbers, damaged columns): never a note or a product. */
const mostlyDigits = (s: string) => {
  const chars = s.replace(/\s/g, "");
  return chars.length > 0 && (chars.match(/\d/g) ?? []).length / chars.length >= 0.5;
};

/** "2 FOR $8.00" offer heading, optionally with its signed saving ("2 FOR $8.00 2.00-"). */
const OFFER = /^(\d{1,3})\s*[.-]?\s*FOR\s+(?:S?\$\s*)?\d+[.,]\d{2}\b/i;

/** Only the amount (and OCR noise around it) is on the line: "  51.80", "[ 4.20 V", "| 3.10". */
function loneAmount(l: Line): boolean {
  if (l.amounts.length !== 1) return false;
  const a = l.amounts[0]!;
  return (
    /^[\s:[\]|/!Il]*$/.test(l.text.slice(0, a.start)) && /^\s*[A-Z]?\s*$/i.test(l.text.slice(a.end))
  );
}

const appendNote = (item: ReceiptItem, note: string) => {
  const n = note.replace(/^[+>~•·*\-\s]+/, "").trim();
  if (n) item.description = `${item.description} (${n})`.slice(0, 80);
};

export function parseReceiptText(text: string): ParseResult {
  return parseReceiptLines(text.split(/\r?\n/), text);
}

interface TotalRow {
  cents: number;
  /** Label and amount were on separate lines ("TOTAL" / "51.80"): weaker evidence. */
  split: boolean;
  /** Number of charge/discount/rounding lines read before this total. */
  chargesBefore: number;
  /** Index in `roundingRows` order: rounding rows seen before this total. */
  roundingBefore: number;
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
  const hasItemHeader = lines.some((l) => !l.amounts.length && qtyColumnsOf(l.text) !== null);

  // Merchant: first wordy, unpriced line in the top section that isn't a known heading.
  for (const l of lines.slice(0, 8)) {
    if (l.amounts.length || ITEM_HEADER.test(l.text)) break;
    if (NOT_MERCHANT.test(l.label) || l.kind === "noise" || !isWordy(l.label)) continue;
    r.merchant = l.label.slice(0, 60);
    break;
  }
  if (!r.merchant) uncertain.add("merchant");

  const items: ReceiptItem[] = [];
  /** Items whose quantity was printed explicitly (x, @, a Qty column, unit × qty = total). */
  const qtyObserved = new Set<ReceiptItem>();
  const skipped: string[] = [];
  const totals: TotalRow[] = [];
  const taxParts: Array<{ cents: number; isTotal: boolean }> = [];
  const lineDiscounts: Array<{ item: ReceiptItem; cents: number; desc: string }> = [];
  const savings: number[] = [];
  const roundingRows: Array<{ cents: number | null; text: string; afterItems: boolean }> = [];
  let repeatedDiscount = 0;
  let serviceAmt: number | null = null;
  let serviceChargeOnly: number | null = null;
  let serviceRateBp: number | null = null;
  let taxRateBp: number | null = null;
  let taxIsGst = false;
  let damagedTotal: { cents: number; text: string } | null = null;
  let damagedSubtotal: { cents: number; text: string } | null = null;
  let chargesSeen = 0;
  const feeLines: string[] = []; // fee lines added to serviceAmt (D6), for the review warning
  let anyTaxMarked = false;
  let subtotalSeen = false;
  let pendingName: string | null = null;
  let pendingKind: LineKind | null = null;
  let cols: QtyColumns = NO_QTY_COLUMNS;
  let unitPriceLayout = false;
  /** Leading lines of a description that wraps onto the priced line below. */
  let wrapPrefix: string[] = [];
  /** Item on the line above whose description is cut off and continues on this line. */
  let openItem: ReceiptItem | null = null;
  let section: Section = hasItemHeader ? "header" : "items";
  const last = () => items[items.length - 1];

  const dropPrefix = () => {
    if (wrapPrefix.length) skipped.push(wrapPrefix.join(" "));
    wrapPrefix = [];
  };
  /**
   * Owner decision (7 Nov 2026): OCR letters inside a number are still repaired ("1O.5O" → 10.50),
   * but whatever uses that amount is marked uncertain and the warning names the printed text.
   */
  const noteRepair = (amounts: Amount[], field: string | null, item?: ReceiptItem) => {
    const repaired = amounts.filter((a) => a.repairedFrom !== undefined);
    if (!repaired.length) return;
    if (item) item.flagged = true;
    if (field) uncertain.add(field);
    for (const a of repaired)
      warnings.push(
        `“${a.repairedFrom}” was read as ${fmt(a.negative ? -a.cents : a.cents)} after fixing letters in the number. Please check it.`,
      );
  };
  const pushItem = (item: ReceiptItem, observed: boolean) => {
    items.push(item);
    if (observed) qtyObserved.add(item);
    return item;
  };
  /** A product whose price can't be read: kept, flagged, with no price (never borrowed). */
  const unpricedItem = (label: string, warning: string, columns: QtyColumns = cols) => {
    const s = splitItemLabel(label, columns);
    if (s.taxMarked) anyTaxMarked = true;
    pushItem(
      {
        id: newId("i"),
        description: s.desc.slice(0, 80),
        quantity: s.quantity,
        lineTotalCents: null,
        flagged: true,
      },
      s.qtyObserved,
    );
    uncertain.add("items");
    warnings.push(warning);
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const continues: ReceiptItem | null = openItem;
    openItem = null;
    if (INCLUSIVE_NOTE.test(l.text) && !l.amounts.length) r.gstInclusive = true;
    const heading = l.amounts.length ? null : qtyColumnsOf(l.text);
    if (heading && section !== "summary" && section !== "footer") {
      cols = heading;
      unitPriceLayout = UNIT_PRICE_HEADER.test(l.text);
      section = "items";
      continue;
    }
    if (l.kind === "noise" || l.kind === "count" || l.kind === "info") {
      pendingKind = null;
      continue;
    }
    if (/^[-=_*.~#\s]+$/.test(l.text)) continue;
    // Shop address above the first item ("Unit 3.12", "#02-15", "Singapore 123456").
    if (!items.length && section !== "summary" && section !== "footer" && ADDRESS.test(l.text))
      continue;

    // ---- Lines without an amount ----------------------------------------------------------
    if (!l.amounts.length) {
      // P4: a total/subtotal whose decimal point was lost ("Total 52455"): a candidate only.
      const damaged = /^(.*?\p{L}.*?)\s*[:=]?\s*(?:S?\$\s*)?(\d{3,6})\s*$/u.exec(l.text);
      if (damaged && nf.minorDigits === 2) {
        const kind = classifyLabel(cleanLabel(damaged[1]!));
        if (kind === "total" || kind === "subtotal") {
          const cand = { cents: Number(damaged[2]), text: l.text };
          if (kind === "total" && section !== "footer") damagedTotal ??= cand;
          if (kind === "subtotal") damagedSubtotal ??= cand;
          section = section === "footer" ? "footer" : "summary";
          continue;
        }
      }
      if (l.kind && SUMMARY.has(l.kind)) {
        dropPrefix();
        pendingKind = l.kind;
        if (l.kind === "total" || l.kind === "subtotal") section = "summary";
        continue;
      } // amount on the next line
      if (l.kind === "payment") {
        dropPrefix();
        if (totals.length || damagedTotal) section = "footer";
        continue;
      }
      if (section !== "items") continue;
      if (isFinancialNote(l.label)) {
        // A damaged tax note: keep it out of the items, and don't join its numeric debris to anything.
        const after = lines[i + 1];
        if (
          after &&
          /^[\d\s:[\]|/]/.test(after.text) &&
          /\d/.test(after.text) &&
          letterCount(after.text) <= 3
        )
          i++;
        skipped.push(l.text);
        uncertain.add("charges");
        warnings.push(
          "A damaged tax line was kept out of the items. Check the GST and the lines under it.",
        );
        continue;
      }
      if (letterCount(splitItemLabel(l.label).desc) < 2) continue;
      const vocab = NOT_A_NOTE.test(l.words) || mostlyDigits(l.label);
      const open = OPEN_END.test(l.label);
      if (continues && continues === last() && !vocab) {
        // Wrapped description: the item above ended on a joining word, so this line continues it.
        continues.description = `${continues.description} ${l.label}`.slice(0, 80);
        if (open) openItem = continues;
        continue;
      }
      const next = lines[i + 1];
      if (open && !vocab && !isDetailRow(next)) {
        wrapPrefix.push(l.label); // the description goes on below; the price comes later
        continue;
      }
      const label = [...wrapPrefix, l.label].join(" ");
      wrapPrefix = [];
      // A product name may contain summary words ("TAX-FREE COLA"); only a line that reads as a
      // summary, payment or noise line is ruled out.
      const productLike =
        !l.kind &&
        !mostlyDigits(l.label) &&
        label !== r.merchant &&
        !NOT_MERCHANT.test(label) &&
        !INCLUSIVE_NOTE.test(label) &&
        letterCount(label) >= 2;

      // Split rows (parser-v2): a description followed by a row of numbers only.
      if (productLike && next && next.kind === null && !OFFER.test(next.text)) {
        const qtyAmount = /^\s*(\d{1,3})\s+(\S.*)$/.exec(next.text);
        const rest = qtyAmount ? readLine(qtyAmount[2]!, nf) : null;
        if (next.amounts.length === 1 && rest && loneAmount(rest) && !rest.amounts[0]!.negative) {
          // "VITAMIN B 12" / "2 16.00": the row's own quantity and amount.
          const s = splitItemLabel(label);
          const q = Number(qtyAmount![1]);
          pushItem(
            {
              id: newId("i"),
              description: s.desc.slice(0, 80),
              quantity: q >= 1 && q <= 99 ? q : 1,
              lineTotalCents: rest.amounts[0]!.cents,
              flagged: q < 1 || q > 99 || letterCount(s.desc) < 4,
            },
            q >= 1 && q <= 99,
          );
          if (s.taxMarked) anyTaxMarked = true;
          noteRepair(rest.amounts, null, last());
          i++;
          continue;
        }
        if (loneAmount(next) && !next.amounts[0]!.negative && !unitPriceLayout) {
          // A readable line amount whose quantity column was lost: keep it, flagged.
          const s = splitItemLabel(label);
          pushItem(
            {
              id: newId("i"),
              description: s.desc.slice(0, 80),
              quantity: 1,
              lineTotalCents: next.amounts[0]!.cents,
              flagged: true,
            },
            false,
          );
          if (s.taxMarked) anyTaxMarked = true;
          noteRepair(next.amounts, null, last());
          uncertain.add("items");
          warnings.push(
            "An item has a readable line amount but an unreadable quantity. Confirm its quantity.",
          );
          i++;
          continue;
        }
        if (
          isDetailRow(next) &&
          /[@x×]/i.test(next.text) &&
          !next.amounts.some((a) => a.negative)
        ) {
          pendingName = label; // "MILO 1KG" / "2 @ 8.95  17.90"
          continue;
        }
        if (
          /^[\d\s:[\]|/]/.test(next.text) &&
          /\d/.test(next.text) &&
          letterCount(next.text) <= 3 &&
          !next.amounts.some((a) => a.negative)
        ) {
          // Damaged quantity/price columns: never mine stray digits or borrow a later amount.
          unpricedItem(
            label,
            "An item has unreadable quantity/price columns. Confirm its quantity and line amount.",
          );
          i++;
          continue;
        }
      }
      if (isDetailRow(next) && /[@x×]/i.test(next!.text)) {
        pendingName = label;
        continue;
      }
      if (MODIFIER.test(label) && last() && !vocab) {
        appendNote(last()!, label); // D3: a free add-on is a note on the item above
        continue;
      }
      const s = splitItemLabel(label, cols);
      if (s.taxMarked || (hasItemHeader && /\s\d{1,2}$/.test(l.label))) {
        unpricedItem(label, "An item line was read without its price. Enter its line total.");
        continue;
      }
      // P1: a line that looks like a product becomes its own flagged item with no price, never a
      // note on the item above. Above the first item of a receipt with no item heading it is
      // still header text (shop name, "Order Summary"), so it is ignored there.
      if (productLike && !vocab && letterCount(label) >= 3 && (items.length > 0 || hasItemHeader)) {
        unpricedItem(label, "An item line was read without its price. Enter its line total.");
      }
      continue;
    }

    // ---- Lines with an amount ---------------------------------------------------------------
    const amt = l.amounts[l.amounts.length - 1]!;
    let kind = l.kind;
    let split = false;
    if (
      pendingKind &&
      !kind &&
      letterCount(l.label) < 2 &&
      !/\d/.test(l.text.slice(0, amt.start)) &&
      l.amounts.length === 1
    ) {
      kind = pendingKind; // "TOTAL" on one line, "51.80" on the next
      split = true;
    }
    pendingKind = null;
    if (kind) dropPrefix();

    // An offer heading ("2 FOR $8.00") is not an item; its signed saving needs a matching item (D2).
    const offer = !kind ? OFFER.exec(l.text) : null;
    if (offer) {
      noteRepair(l.amounts, "discount");
      dropPrefix();
      if (!amt.negative || l.amounts.length < 2) continue; // a bare offer description
      const prev = last();
      const n = Number(offer[1]);
      const offerPrice = l.amounts[0]!.cents;
      const supported =
        section === "items" &&
        prev &&
        qtyObserved.has(prev) &&
        prev.quantity === n &&
        prev.lineTotalCents !== null &&
        prev.lineTotalCents - offerPrice === amt.cents;
      if (supported) {
        addDiscount(amt.cents, l.label || "offer");
        prev.flagged = true;
        uncertain.add("discount");
        warnings.push(
          `An offer saving of ${fmt(amt.cents)} matches the item above and was taken off it. Please check it.`,
        );
      } else {
        skipped.push(l.text);
        uncertain.add("discount");
        warnings.push(
          "An offer saving could not be matched to an item, so it was not deducted. Check the discount.",
        );
      }
      continue;
    }

    // A free option under an item ("- Less sugar 0.00") is a note, not a discount or a new item.
    if (amt.cents === 0 && (kind === null || kind === "discount") && section === "items") {
      if (last() && !NOT_A_NOTE.test(l.words)) appendNote(last()!, l.label);
      continue;
    }

    switch (kind) {
      case "subtotal":
        noteRepair(l.amounts, "total");
        if (!subtotalSeen) r.printedSubtotalCents = amt.cents;
        subtotalSeen = true;
        chargesSeen++;
        section = "summary";
        continue;
      case "service": {
        noteRepair(l.amounts, "charges");
        chargesSeen++;
        section = "summary";
        if (amt.negative) {
          // Fees add up (D6); a fee discount ("Delivery Discount -1.00") reduces them. Any other
          // signed service amount is kept for review, never turned into a positive charge.
          if (
            serviceAmt !== null &&
            /\b(?:disc(?:ount)?|promo|off|waiver|waived|free|voucher|rebate)\b/i.test(l.words)
          ) {
            serviceAmt -= amt.cents;
          } else {
            skipped.push(l.text);
            uncertain.add("charges");
            warnings.push(
              "A service charge is printed with a minus sign. It was not used; check the service charge.",
            );
          }
          continue;
        }
        serviceAmt = (serviceAmt ?? 0) + amt.cents;
        if (FEE.test(l.label) && amt.cents > 0) feeLines.push(`${l.label} ${fmt(amt.cents)}`);
        else {
          serviceChargeOnly = (serviceChargeOnly ?? 0) + amt.cents;
          const bp = findRateBp(l.label);
          if (bp !== null) {
            r.serviceRateBp = bp;
            serviceRateBp = bp;
          }
        }
        continue;
      }
      case "tax": {
        noteRepair(l.amounts, "charges");
        chargesSeen++;
        section = "summary";
        if (amt.negative) {
          skipped.push(l.text);
          uncertain.add("charges");
          warnings.push(
            "A tax amount is printed with a minus sign. It was not used; check the GST.",
          );
          continue;
        }
        taxParts.push({ cents: amt.cents, isTotal: /\b(?:total|amount|amt)\b/i.test(l.words) });
        if (INCLUSIVE_NOTE.test(l.text) || /^incl/i.test(l.label)) r.gstInclusive = true;
        if (/\bgst\b/i.test(l.words)) taxIsGst = true;
        const bp = findRateBp(l.label);
        if (bp !== null) {
          r.gstRateBp = bp;
          taxRateBp = bp;
        }
        continue;
      }
      case "discount": {
        noteRepair(l.amounts, "discount");
        chargesSeen++;
        const itemLevel = lineDiscounts.reduce((s2, d) => s2 + d.cents, 0) - repeatedDiscount;
        if (section !== "items" && itemLevel > 0 && amt.cents === itemLevel) {
          // P3: the item discounts above, repeated in the summary. Not counted again.
          repeatedDiscount += amt.cents;
          warnings.push(
            `A discount of ${fmt(amt.cents)} repeats the item discounts above, so it was not counted again.`,
          );
          continue;
        }
        addDiscount(amt.cents, l.label);
        continue;
      }
      case "savings":
        savings.push(amt.cents);
        section = section === "footer" ? "footer" : "summary";
        continue;
      case "rounding": {
        noteRepair(l.amounts, "total");
        chargesSeen++;
        const before = l.text.slice(0, amt.start);
        const signed = amt.negative || /\+\s*$/.test(before) || amt.cents === 0;
        roundingRows.push({
          cents: signed ? (amt.negative ? -amt.cents : amt.cents) : null,
          text: l.text,
          afterItems: items.length > 0,
        });
        continue;
      }
      case "total":
        if (section !== "footer") noteRepair(l.amounts, "total");
        if (section !== "footer")
          totals.push({
            cents: amt.cents,
            split,
            chargesBefore: chargesSeen,
            roundingBefore: roundingRows.length,
          });
        if (INCLUSIVE_NOTE.test(l.text) && !taxParts.length) r.gstInclusive = true;
        section = section === "footer" ? "footer" : "summary";
        continue;
      case "payment":
        if (totals.length) section = "footer";
        continue;
      default:
        break;
    }

    if (section === "footer") continue;
    const row = readItemRow(l.text, l.amounts, l.rawLabel.replace(/^[^\p{L}\p{N}(+>]+/u, ""), cols);
    const ownName = letterCount(row.desc) >= 2;
    if (amt.negative && section !== "header") {
      if (ownName && !MODIFIER.test(l.label)) {
        // "SOAP -3.00": a minus sign on a product is ambiguous (return? discount?). Never a discount.
        unpricedItem(
          l.label,
          "An item has a minus sign. Confirm its line amount and whether it is a discount or a return.",
        );
        uncertain.add("discount");
        continue;
      }
      addDiscount(amt.cents, l.label);
      continue;
    }
    if (section === "summary" || section === "header") {
      // After a total, only a row with an explicit quantity is still a product (parser-v2).
      if (section === "summary" && ownName && row.qtyObserved && !subtotalSeen) {
        pushItem(
          {
            id: newId("i"),
            description: row.desc,
            quantity: row.quantity,
            lineTotalCents: row.lineTotalCents,
            flagged: true,
          },
          true,
        );
        uncertain.add("items");
        continue;
      }
      skipped.push(l.text);
      continue;
    }

    // A unit-price layout whose final amount is damaged ("FILM (Adult) 12.00 | 2 XOO -"):
    // the only amount is the unit price, so the line total is unknown.
    if (
      unitPriceLayout &&
      l.amounts.length === 1 &&
      ownName &&
      /[\p{L}\d?]/u.test(l.text.slice(amt.end).replace(/^\s*[A-Z]?\s*$/i, ""))
    ) {
      unpricedItem(
        l.rawLabel,
        "An item has damaged unit-price, quantity or amount columns. Confirm its highlighted values.",
      );
      continue;
    }

    if (!ownName) {
      if (!pendingName) {
        skipped.push(l.text);
        continue;
      }
      const s = splitItemLabel(pendingName);
      row.desc = s.desc.slice(0, 80);
      row.taxMarked ||= s.taxMarked;
      row.uncertain = row.uncertain && letterCount(s.desc) < 4;
      if (s.qtyObserved && s.quantity > 1 && row.quantity === 1) {
        row.quantity = s.quantity;
        row.qtyObserved = true;
      }
    }
    pendingName = null;
    if (wrapPrefix.length) {
      row.desc = [...wrapPrefix, row.desc].join(" ").slice(0, 80);
      wrapPrefix = [];
    }
    if (row.taxMarked) anyTaxMarked = true;

    const prev = last();
    if (prev && (MODIFIER.test(l.label) || amt.cents === 0)) {
      // D3: an add-on belongs to whoever had the item above it.
      if (prev.lineTotalCents !== null) prev.lineTotalCents += amt.cents;
      appendNote(prev, amt.cents ? `${l.label} ${fmt(amt.cents)}` : l.label);
      noteRepair(l.amounts, null, prev);
      continue;
    }
    if (amt.cents === 0) continue;
    const item = pushItem(
      {
        id: newId("i"),
        description: row.desc,
        quantity: row.quantity,
        lineTotalCents: row.lineTotalCents,
        flagged: row.uncertain,
      },
      row.qtyObserved,
    );
    noteRepair(l.amounts, null, item);
    if (OPEN_END.test(row.desc)) openItem = item;
  }
  dropPrefix();

  function addDiscount(cents: number, label: string) {
    const prev = items[items.length - 1];
    // D2: a discount printed right under an item, before any subtotal, belongs to that item.
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

  // D2: if the printed subtotal is the pre-discount figure, the item discounts are a bill discount.
  const lineDisc = lineDiscounts.reduce((s, d) => s + d.cents, 0);
  let movedBack = false;
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
    movedBack = true;
  }

  // P3: a savings summary ("Total savings 2.00") is compared with the discounts read, never
  // deducted again. On its own it is informational and flagged (parser-v2).
  const applied = movedBack ? r.discountCents : lineDisc + r.discountCents;
  if (savings.length) {
    const distinct = new Set(savings);
    if (distinct.size > 1) {
      uncertain.add("discount");
      warnings.push("Printed discount summaries disagree. Check the discount amount.");
    }
    const summary = savings[savings.length - 1]!;
    if (!applied) {
      uncertain.add("discount");
      warnings.push(
        `A savings summary of ${fmt(summary)} was printed but no discount line was found. It was not deducted; check the discount.`,
      );
    } else if (summary !== applied) {
      uncertain.add("discount");
      warnings.push(
        `Discount lines add up to ${fmt(applied)} but the savings summary is ${fmt(summary)}. Check the discount; the summary was not deducted again.`,
      );
    }
  }

  // Total: the last one printed before payment (a label-and-amount line beats a split one).
  // With cash rounding (D4), the figure before rounding.
  const direct = totals.filter((t) => !t.split);
  const pool = direct.length ? direct : totals;
  const chosen = pool[pool.length - 1] ?? null;
  for (let k = 1; k < direct.length; k++) {
    const a = direct[k - 1]!;
    const b = direct[k]!;
    if (a.cents !== b.cents && a.chargesBefore === b.chargesBefore) {
      // Two different totals with nothing between them to explain it (parser-v2): flag, don't pick silently.
      uncertain.add("total");
      warnings.push(
        `Printed totals disagree (${fmt(a.cents)} and ${fmt(b.cents)}). Confirm the total; neither was changed.`,
      );
      break;
    }
  }
  if (direct.length && totals.some((t) => t.split && t.cents !== chosen!.cents))
    uncertain.add("total");

  // D4 + parser-v2 rounding rules: one signed row of at most 5 cents, after the items, is applied.
  const nonzero = roundingRows.filter((x) => x.cents !== 0);
  let rounding: number | null = null;
  if (nonzero.length > 1) {
    uncertain.add("total");
    warnings.push("More than one rounding line was printed, so none was applied. Check the total.");
  } else if (nonzero.length === 1) {
    const row = nonzero[0]!;
    if (row.cents === null) {
      uncertain.add("total");
      warnings.push(
        `The rounding line “${row.text.slice(0, 40)}” has no readable sign, so it was not applied.`,
      );
    } else if (Math.abs(row.cents) > MAX_ROUNDING) {
      skipped.push(row.text);
      uncertain.add("total");
      warnings.push(
        `A rounding of ${fmt(row.cents)} is more than 5 cents, so it was treated as a misread and not applied.`,
      );
    } else if (!row.afterItems) {
      uncertain.add("total");
      warnings.push("A rounding line was printed before the items, so it was not applied.");
    } else rounding = row.cents;
  }
  if (rounding !== null && chosen) {
    const beforeRounding = pool.filter((t) => t.roundingBefore === 0);
    r.receiptTotalCents =
      beforeRounding.length && beforeRounding.length < pool.length
        ? beforeRounding[beforeRounding.length - 1]!.cents
        : chosen.cents - rounding;
    warnings.push(
      `The shop rounded the payable amount by ${fmt(rounding)}. Splitting uses the unrounded total ${fmt(r.receiptTotalCents)}.`,
    );
  } else if (chosen) {
    r.receiptTotalCents = chosen.cents;
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

  // P4: a total or subtotal printed without its decimal point is used only if it reconciles.
  const net = sum - r.discountCents;
  const svc = serviceAmt ?? 0;
  if (r.receiptTotalCents === null && damagedTotal) {
    const fits = [net + svc + (taxAmt ?? 0), net + svc].includes(damagedTotal.cents);
    if (fits && items.length && items.every((it) => it.lineTotalCents !== null)) {
      r.receiptTotalCents = damagedTotal.cents;
      uncertain.add("total");
      warnings.push(
        `The total “${damagedTotal.text.slice(0, 40)}” has no decimal point. It was read as ${fmt(damagedTotal.cents)} because that matches the items and charges. Please check it.`,
      );
    } else {
      warnings.push(
        `The total “${damagedTotal.text.slice(0, 40)}” has no decimal point and doesn't match the items, so it was not used.`,
      );
    }
  }
  if (r.printedSubtotalCents === null && damagedSubtotal) {
    if (damagedSubtotal.cents === sum || damagedSubtotal.cents === net) {
      r.printedSubtotalCents = damagedSubtotal.cents;
      uncertain.add("items");
      warnings.push(
        `The subtotal “${damagedSubtotal.text.slice(0, 40)}” has no decimal point. It was read as ${fmt(damagedSubtotal.cents)} because that matches the items. Please check it.`,
      );
    }
  }

  // First, so it survives the 20-warning cap on what is stored.
  if (feeLines.length)
    warnings.unshift(`${FOLDED_FEES_NOTE} ${feeLines.join(", ")}.`.slice(0, 300));

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
    uncertain.add("currency");
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
  checkChargeRates(
    r,
    {
      sum,
      printedTaxRateBp: taxRateBp,
      taxIsGst,
      singleTaxLine: taxParts.length === 1,
      serviceChargeCents: feeLines.length ? serviceChargeOnly : serviceAmt,
      printedServiceRateBp: serviceRateBp,
      defaultGstRateBp: !currency.code || currency.code === "SGD" ? DEFAULT_GST_BP : null,
    },
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
