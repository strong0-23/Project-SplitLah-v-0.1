/**
 * Reads one purchased-item row. Pure.
 *
 * Supported row shapes (any spacing, any of the number formats in ./numbers):
 *   COFFEE                     7.00      price only
 *   2 x COFFEE / 2X COFFEE     7.00      leading quantity
 *   COFFEE x2 / COFFEE 2       7.00      trailing quantity (incl. a Qty column)
 *   COFFEE   2   3.50          7.00      qty | unit | total columns
 *   COFFEE   3.50   2          7.00      unit | qty | total columns
 *   2 @ 3.50                   7.00      detail row under a name row (supermarkets)
 *   BANANA 0.512kg @ 3.98/kg   2.04      weighed goods (quantity stays 1)
 * The line total (last amount) is always what is billed; unit prices only confirm the quantity.
 */
import { ITEM_TAX_MARKER, WEIGHT } from "./lexicon";
import type { Amount } from "./numbers";

export interface ItemRow {
  desc: string;
  quantity: number;
  lineTotalCents: number;
  /** Unsure about the description, quantity or price. */
  uncertain: boolean;
  taxMarked: boolean;
}

export interface ItemSplit {
  desc: string;
  quantity: number;
  qtyUncertain: boolean;
  taxMarked: boolean;
  weighed: boolean;
}

const MAX_QTY = 99;

/** Separates description, item tax marker and a leading OR trailing quantity. */
export function splitItemLabel(label: string): ItemSplit {
  let desc = label.trim();
  let quantity = 1;
  let qtyUncertain = false;
  let taxMarked = false;
  const weighed = WEIGHT.test(desc);
  // Drop a trailing unit-price marker ("Coffee 2 @", "2 @ 3.50", "x") — the line total is kept separately.
  desc = desc.replace(/\s*(?:@|x|×|\*)\s*$/i, "").replace(/\s*@\s*\S*\d[.,]\d{2}\S*\s*$/, "");
  if (ITEM_TAX_MARKER.test(desc)) {
    taxMarked = true;
    desc = desc.replace(ITEM_TAX_MARKER, "");
  }

  // Trailing quantity: "NAAN(GST*) 2", "LATTE x2", "LATTE X 2". OCR may read "1" as I, l, | or !.
  const trail =
    /^(.*?[\p{L})\]*#+.])\s+(?:[x×]\s?)?(\d{1,2}|[Il|!])$/u.exec(desc) ??
    /^(.*?\p{L}.*?)\s*[x×]\s?(\d{1,2})$/iu.exec(desc);
  const lead =
    /^(\d{1,2})\s*[x×*]?\s+(.+)$/i.exec(desc) ?? /^(\d{1,2})\s*[x×*]\s*(.+)$/i.exec(desc);
  if (trail && !weighed) {
    const raw = trail[2] ?? "1";
    quantity = /\d/.test(raw) ? Number(raw) : 1;
    qtyUncertain = !/\d/.test(raw);
    desc = trail[1] ?? desc;
  } else if (lead && Number(lead[1]) > 0) {
    quantity = Number(lead[1]);
    desc = lead[2] ?? desc;
  }
  if (quantity < 1 || quantity > MAX_QTY) {
    quantity = 1;
    qtyUncertain = true;
  }
  if (ITEM_TAX_MARKER.test(desc)) {
    taxMarked = true;
    desc = desc.replace(ITEM_TAX_MARKER, "");
  }
  desc = desc
    .replace(/[^\p{L}\p{N}&'()./+%\- ]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-./]+|[\s\-./]+$/g, "")
    .trim();
  return { desc, quantity, qtyUncertain, taxMarked, weighed };
}

export const letterCount = (s: string) => (s.match(/\p{L}/gu) ?? []).length;

/**
 * Interprets a priced row. `amounts` are all money values on the line (left to right); text before
 * the first amount is the label, text between amounts may hold a quantity column.
 */
export function readItemRow(line: string, amounts: Amount[], rawLabel: string): ItemRow {
  const total = amounts[amounts.length - 1]!;
  const s = splitItemLabel(rawLabel);
  let { quantity } = s;
  let uncertain = s.qtyUncertain;

  if (amounts.length >= 2 && !s.weighed) {
    const unit = amounts[amounts.length - 2]!.cents;
    const between = line.slice(amounts[amounts.length - 2]!.end, total.start).trim();
    const qBetween = /^(?:[x×]\s?)?(\d{1,2})$/i.exec(between);
    if (qBetween) quantity = Number(qBetween[1]);
    if (unit > 0 && quantity * unit === total.cents) {
      uncertain = false; // columns agree
    } else if (
      unit > 0 &&
      quantity === 1 &&
      total.cents % unit === 0 &&
      total.cents / unit <= MAX_QTY
    ) {
      quantity = total.cents / unit; // qty not printed but unit × n = total
    } else if (unit !== total.cents) {
      uncertain = true; // the columns disagree: keep the line total and ask the user
    }
  }

  const letters = letterCount(s.desc);
  if (letters < 4 || /[|{}[\]]/.test(rawLabel)) uncertain = true;
  return {
    desc: s.desc.slice(0, 80),
    quantity,
    lineTotalCents: total.cents,
    uncertain,
    taxMarked: s.taxMarked,
  };
}
