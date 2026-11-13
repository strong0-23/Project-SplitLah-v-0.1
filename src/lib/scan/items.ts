/**
 * Reads one purchased-item row. Pure.
 *
 * Supported row shapes (any spacing, any of the number formats in ./numbers):
 *   COFFEE                     7.00      price only (quantity 1, as printed)
 *   2 x COFFEE / 2X COFFEE     7.00      explicit leading quantity
 *   COFFEE x2                  7.00      explicit trailing quantity
 *   COFFEE 2 @ 3.50            7.00      explicit quantity and unit price, then the line total
 *   COFFEE 2 @ 3.50                      unit price only: the line total is unknown (flagged)
 *   COFFEE 2                   7.00      bare trailing number: a quantity ONLY under a Qty heading
 *   COFFEE   2   3.50          7.00      qty | unit | total columns
 *   COFFEE   3.50   2          7.00      unit | qty | total columns
 *   2 @ 3.50                   7.00      detail row under a name row (supermarkets)
 *   BANANA 0.512kg @ 3.98/kg   2.04      weighed goods (quantity stays 1)
 * The line total (last amount) is always what is billed; unit prices only confirm the quantity.
 * An amount printed straight after "@" is a unit price, never the line total: with no second
 * amount the line total stays unknown and the row is flagged (parser-v2 rule, Batch 2a).
 *
 * A bare number next to a name ("VITAMIN B 12", "100 PLUS", "SOAP 2") is part of the product's
 * name unless a Qty column heading says otherwise, or the row's own unit price × that number
 * equals the line total. Otherwise it stays in the description and the row is flagged
 * (parser-v2 rule, owner decision 7 Nov 2026). A decimal or fractional number next to a name
 * ("VERSION 2.5", "LOOSE TEA 1/2", "0.5 x LOOSE TEA") also stays in the name and flags the row:
 * fractional quantities can't be stored, so the user checks it (parser-v2 rule, Batch 2a).
 */
import { ITEM_TAX_MARKER, WEIGHT } from "./lexicon";
import type { Amount } from "./numbers";

/** Which bare quantity columns a printed heading establishes ("Qty Description Amount" → leading). */
export interface QtyColumns {
  leading: boolean;
  trailing: boolean;
}
export const NO_QTY_COLUMNS: QtyColumns = { leading: false, trailing: false };

export interface ItemRow {
  desc: string;
  quantity: number;
  /** null when the row prints only a unit price ("COFFEE 2 @ 3.50"). */
  lineTotalCents: number | null;
  /** The unit price printed after "@" when no line total follows it; otherwise null. */
  unitPriceOnlyCents: number | null;
  /** Unsure about the description, quantity or price. */
  uncertain: boolean;
  taxMarked: boolean;
  /** The quantity was printed explicitly (x / @ / a Qty column / unit × qty = total). */
  qtyObserved: boolean;
  /**
   * The bare number D7 left in `desc` unresolved (no Qty heading, no unit × number = total), for
   * D15 (`confirmQuantitiesByCount` in parse.ts). null when there is none or the quantity was read.
   */
  bareNumber: BareNumber | null;
  /** The row is doubtful for a reason other than that bare number (columns, short name, …). */
  otherDoubt: boolean;
}

/** A plain number at one end of an item name, kept in the name because nothing shows it is a quantity. */
export interface BareNumber {
  value: number;
  /** The name without the number (and without a per-item tax marker in front of it). */
  descWithout: string;
  at: "start" | "end";
  /** A per-item tax marker stood between the name and the number ("SOUP(GST*) 2"). */
  taxMarked: boolean;
  /** The name also has a whole number at its other end ("2 SOAP 3"): which one is meant is unknown. */
  bothEnds: boolean;
}

export interface ItemSplit {
  desc: string;
  quantity: number;
  qtyUncertain: boolean;
  taxMarked: boolean;
  weighed: boolean;
  /** The quantity was printed explicitly (x / @ / a Qty column). */
  qtyObserved: boolean;
  /** A bare number kept in `desc` because nothing shows it is a quantity. */
  bareNumber: BareNumber | null;
}

const MAX_QTY = 99;
/** A trailing number introduced by No/Model/ID/Code/SKU is an identifier, never a quantity. */
const IDENTIFIER = /\b(?:no\.?|model|id|code|sku)\s*\d+\s*$/i;
/** A decimal or fractional number at either end of a name: "VERSION 2.5", "1/2 CHICKEN". */
const FRACTIONAL_EDGE = /^\d{1,3}(?:[.,]\d{1,3}|\/\d{1,3})\s|\s\d{1,3}(?:[.,]\d{1,3}|\/\d{1,3})$/;
/** Text just before an amount that makes it a unit price: "@", "@ $", "@ S$". */
const AT_UNIT = /@\s*(?:S?\$|RM|Rp)?\s*$/i;

/** Separates description, item tax marker and an explicit or column-backed quantity. */
export function splitItemLabel(label: string, cols: QtyColumns = NO_QTY_COLUMNS): ItemSplit {
  let desc = label.trim();
  let quantity = 1;
  let qtyUncertain = false;
  let qtyObserved = false;
  let taxMarked = false;
  let bareNumber: ItemSplit["bareNumber"] = null;
  const weighed = WEIGHT.test(desc);
  const setQty = (n: number, uncertain = false) => {
    quantity = n;
    qtyObserved = !uncertain;
    qtyUncertain = uncertain;
  };

  // Explicit leading multiplication wins: "2 x VITAMIN B 12 @" is 2 of "VITAMIN B 12".
  const explicitLead = /^(\d{1,3})\s*[x×*]\s*(.+)$/i.exec(desc);
  if (explicitLead && Number(explicitLead[1]) > 0) {
    setQty(Number(explicitLead[1]));
    desc = explicitLead[2] ?? desc;
  }
  // Explicit quantity before a unit price: "Cappuccino 2 x", "COFFEE 2 @", "2 @".
  const unitMarker = qtyObserved ? null : /^(.*?)\s*\b(\d{1,3})\s*[x×*@]\s*$/i.exec(desc);
  if (unitMarker && !weighed) {
    setQty(Number(unitMarker[2]));
    desc = unitMarker[1] ?? "";
  }
  // Drop a trailing unit-price marker ("Coffee @", "@ 3.50") — the line total is kept separately.
  desc = desc.replace(/\s*(?:@|x|×|\*)\s*$/i, "").replace(/\s*@\s*\S*\d[.,]\d{2}\S*\s*$/, "");
  if (ITEM_TAX_MARKER.test(desc)) {
    taxMarked = true;
    desc = desc.replace(ITEM_TAX_MARKER, "");
  }

  if (!qtyObserved) {
    const explicitTrail = /^(.*?\p{L}.*?)\s*[x×]\s?(\d{1,3})$/iu.exec(desc);
    const bareTrail = /^(.*?[\p{L}\p{N})\]*#+.%])\s+(\d{1,3}|[Il|!])$/u.exec(desc);
    const bareLead = /^(\d{1,3})\s+(?![.-]?\s*FOR\b)(.*\p{L}.*)$/iu.exec(desc);
    if (explicitTrail && !weighed) {
      setQty(Number(explicitTrail[2]));
      desc = explicitTrail[1] ?? desc;
    } else if (bareLead && cols.leading) {
      // A leading Qty column ("Qty Description Amount") is read before any trailing number.
      setQty(Number(bareLead[1]));
      desc = bareLead[2] ?? desc;
    } else if (bareTrail && !weighed && !IDENTIFIER.test(desc)) {
      const raw = bareTrail[2] ?? "";
      const glyph = !/\d/.test(raw); // OCR may read "1" as I, l, | or !
      if (cols.trailing) {
        setQty(glyph ? 1 : Number(raw), glyph);
        desc = bareTrail[1] ?? desc;
      } else if (!glyph) {
        bareNumber = bare(Number(raw), bareTrail[1] ?? desc, "end", desc);
      } else qtyUncertain = true;
    } else if (bareLead && !weighed) {
      bareNumber = bare(Number(bareLead[1]), bareLead[2] ?? desc, "start", desc);
    } else if (!weighed && !IDENTIFIER.test(desc) && FRACTIONAL_EDGE.test(desc)) {
      qtyUncertain = true; // could be a fractional quantity: kept in the name, flagged
    }
  }
  if (quantity < 1 || quantity > MAX_QTY) {
    quantity = 1;
    qtyObserved = false;
    qtyUncertain = true;
  }
  if (ITEM_TAX_MARKER.test(desc)) {
    taxMarked = true;
    desc = desc.replace(ITEM_TAX_MARKER, "");
  }
  const tidy = (d: string) =>
    d
      .replace(/[^\p{L}\p{N}&'()./+%\- ]/gu, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s\-./]+|[\s\-./]+$/g, "")
      .trim();
  desc = tidy(desc);
  if (bareNumber) {
    let without = bareNumber.descWithout;
    if (bareNumber.at === "end" && ITEM_TAX_MARKER.test(without)) {
      // "SOUP(GST*) 2": the tax marker sat between the name and the number.
      bareNumber.taxMarked = true;
      without = without.replace(ITEM_TAX_MARKER, "");
    }
    bareNumber.descWithout = tidy(without);
    // Unless confirmed later, an unexplained number makes the quantity uncertain.
    qtyUncertain = true;
  }
  return { desc, quantity, qtyUncertain, taxMarked, weighed, qtyObserved, bareNumber };
}

/** A whole number at both ends of a name ("2 SOAP 3"), after any tax marker before the last one. */
const BOTH_ENDS = /^\d+\s.*\s\d+$/;
const bare = (
  value: number,
  descWithout: string,
  at: BareNumber["at"],
  desc: string,
): BareNumber => ({
  value,
  descWithout,
  at,
  taxMarked: false,
  bothEnds: BOTH_ENDS.test(desc.trim()),
});

export const letterCount = (s: string) => (s.match(/\p{L}/gu) ?? []).length;

/**
 * Interprets a priced row. `amounts` are all money values on the line (left to right); text before
 * the first amount is the label, text between amounts may hold a quantity column.
 */
export function readItemRow(
  line: string,
  amounts: Amount[],
  rawLabel: string,
  cols: QtyColumns = NO_QTY_COLUMNS,
): ItemRow {
  const total = amounts[amounts.length - 1]!;
  const s = splitItemLabel(rawLabel, cols);
  let { quantity, qtyObserved, desc } = s;
  let uncertain = s.qtyUncertain;
  /** Doubt from anything other than an unresolved bare number (D15 may clear only that one). */
  let otherDoubt = s.qtyUncertain && !s.bareNumber;

  // "COFFEE 2 @ 3.50" / "2 @ 8.95" / "BANANA 0.5kg @ 3.98/kg": the only amount is a unit price.
  // Never copy it into the line total, and never multiply to fill one in (parser-v2).
  const before = line.slice(amounts.length > 1 ? amounts[amounts.length - 2]!.end : 0, total.start);
  if (amounts.length === 1 && AT_UNIT.test(before)) {
    return {
      desc: desc.slice(0, 80),
      quantity,
      lineTotalCents: null,
      unitPriceOnlyCents: total.cents,
      uncertain: true,
      taxMarked: s.taxMarked,
      qtyObserved,
      bareNumber: qtyObserved ? null : s.bareNumber,
      otherDoubt: true,
    };
  }
  // "COFFEE 2 x 3.50": the lone amount may be a unit price or the line total. Kept, flagged.
  if (amounts.length === 1 && /\d\s*[x×*]\s*$/i.test(before)) uncertain = otherDoubt = true;

  let resolved = false;
  if (amounts.length >= 2 && !s.weighed) {
    const unit = amounts[amounts.length - 2]!.cents;
    const between = line.slice(amounts[amounts.length - 2]!.end, total.start).trim();
    const qBetween = /^(?:[x×]\s?)?(\d{1,2})$/i.exec(between);
    if (qBetween) {
      quantity = Number(qBetween[1]);
      qtyObserved = true;
    }
    if (unit > 0 && s.bareNumber && !qtyObserved && s.bareNumber.value * unit === total.cents) {
      // "SOAP 2  1.50  3.00": the row's own unit price × the bare number = line total.
      quantity = s.bareNumber.value;
      desc = s.bareNumber.descWithout;
      qtyObserved = true;
      uncertain = false;
      resolved = true;
    } else if (unit > 0 && quantity * unit === total.cents) {
      if (qtyObserved || quantity === 1) uncertain = s.bareNumber !== null; // columns agree
    } else if (
      unit > 0 &&
      !qtyObserved &&
      total.cents % unit === 0 &&
      total.cents / unit <= MAX_QTY
    ) {
      // Quantity not printed but unit × n = total: auto-filled, so the row is flagged for a check.
      quantity = total.cents / unit;
      uncertain = otherDoubt = true;
    } else if (unit !== total.cents) {
      uncertain = otherDoubt = true; // the columns disagree: keep the line total and ask the user
    }
  }

  const letters = letterCount(desc);
  if (letters < 4 || /[|{}[\]]/.test(rawLabel)) uncertain = otherDoubt = true;
  return {
    desc: desc.slice(0, 80),
    quantity,
    lineTotalCents: total.cents,
    unitPriceOnlyCents: null,
    uncertain,
    taxMarked: s.taxMarked || (resolved && !!s.bareNumber?.taxMarked),
    qtyObserved,
    bareNumber: resolved || qtyObserved ? null : s.bareNumber,
    otherDoubt,
  };
}

/** One item row as D15 sees it: its quantity and line total now, and its unresolved bare number. */
export interface CountRow {
  quantity: number;
  lineTotalCents: number | null;
  /** null when the row has no unresolved bare number; `ok` false when it can't be a candidate. */
  bare: { value: number; ok: boolean } | null;
}

/**
 * D15: quantities confirmed by the receipt's printed item count. Every row with an unresolved bare
 * number (1-99) takes that number as its quantity, every other row keeps its quantity, and the
 * result is used only when the quantities then add up to the printed count exactly. All or
 * nothing: null (change nothing) when no count was read, counts disagree or are not whole, a row
 * has no line total, a candidate row can't be read cleanly (numbers at both ends, …) or already
 * has another quantity, there is no candidate, or the sum is off by even one.
 */
export function quantitiesByItemCount(
  rows: readonly CountRow[],
  counts: readonly string[],
): number[] | null {
  if (!counts.length || !rows.length || !counts.every((c) => /^\d+$/.test(c))) return null;
  const n = Number(counts[0]);
  if (n < 1 || counts.some((c) => Number(c) !== n)) return null;
  const out: number[] = [];
  let sum = 0;
  let candidates = 0;
  for (const row of rows) {
    if (row.lineTotalCents === null) return null;
    if (!row.bare) {
      out.push(row.quantity);
      sum += row.quantity;
      continue;
    }
    const v = row.bare.value;
    if (!row.bare.ok || row.quantity !== 1 || v < 1 || v > MAX_QTY) return null;
    out.push(v);
    sum += v;
    candidates++;
  }
  return candidates > 0 && sum === n ? out : null;
}
