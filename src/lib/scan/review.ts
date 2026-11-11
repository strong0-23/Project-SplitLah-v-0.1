/**
 * Review-screen hints for a scanned receipt, derived again from its stored OCR text. Pure.
 *
 * The receipt keeps only `rawOcrText` (no schema change); parsing that text again gives the same
 * result, so the review screen can show the lines the total anchor set aside and the reason each
 * flagged row is highlighted, after a reload too, without storing anything new.
 */
import { parseReceiptText, type SetAsideRow } from "./parse";

export type { SetAsideRow };

interface RowLike {
  description: string;
  quantity: number;
  lineTotalCents: number | null;
}

/** Identifies a row by what the user sees; an edited row no longer matches. */
export const rowKey = (r: RowLike) => JSON.stringify([r.description, r.quantity, r.lineTotalCents]);

export interface ReviewHints {
  /** Lines set aside as probably not items, in printed order. */
  setAside: SetAsideRow[];
  /** Reason per flagged item, by `rowKey`. */
  reasons: ReadonlyMap<string, string>;
}

const NONE: ReviewHints = { setAside: [], reasons: new Map() };

export function reviewHints(rawOcrText: string | null | undefined): ReviewHints {
  if (!rawOcrText) return NONE;
  const res = parseReceiptText(rawOcrText);
  const reasons = new Map<string, string>();
  res.receipt.items.forEach((it, i) => {
    const reason = res.itemReasons[i];
    const key = rowKey(it);
    if (reason && !reasons.has(key)) reasons.set(key, reason);
  });
  return { setAside: res.setAside, reasons };
}
