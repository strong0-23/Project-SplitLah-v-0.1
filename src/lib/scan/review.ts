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
  /** The scanned text holds no printed total the parser could read (D14). */
  noTotalRead: boolean;
}

const NONE: ReviewHints = { setAside: [], reasons: new Map(), noTotalRead: false };

/**
 * Scan warning added when the reading left much of the printed area unread (D14). It goes in the
 * receipt's existing `ocrWarnings`, like the D6 fees note, so nothing new is stored.
 */
export const PARTLY_READ_NOTE =
  "Part of the receipt could not be read. Check that every item is listed.";

/** True when a scan reported that the photo was only partly read. */
export function hasPartlyReadNote(ocrWarnings: readonly string[] | null | undefined): boolean {
  return !!ocrWarnings?.includes(PARTLY_READ_NOTE);
}

/**
 * Should the review screen warn that the photo was only partly read (D14)? Yes when the scan said
 * so, or when no total was read from the text and the user has not typed one in yet. Pure.
 */
export function readingIncomplete(
  receipt: { ocrWarnings?: string[] | undefined; receiptTotalCents: number | null },
  hints: Pick<ReviewHints, "noTotalRead">,
): { partly: boolean; noTotal: boolean } | null {
  const partly = hasPartlyReadNote(receipt.ocrWarnings);
  const noTotal = hints.noTotalRead && receipt.receiptTotalCents === null;
  return partly || noTotal ? { partly, noTotal } : null;
}

export function reviewHints(rawOcrText: string | null | undefined): ReviewHints {
  if (!rawOcrText) return NONE;
  const res = parseReceiptText(rawOcrText);
  const reasons = new Map<string, string>();
  res.receipt.items.forEach((it, i) => {
    const reason = res.itemReasons[i];
    const key = rowKey(it);
    if (reason && !reasons.has(key)) reasons.set(key, reason);
  });
  return { setAside: res.setAside, reasons, noTotalRead: res.receipt.receiptTotalCents === null };
}
