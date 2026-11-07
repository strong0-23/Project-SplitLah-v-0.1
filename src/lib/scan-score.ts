import { parseReceiptText, scoreParse } from "./parser";
import { computeTotals } from "./bill";
import type { TextScorer } from "./ocr";

/** Shared by the scan UI and local regression harness. No reference answers influence OCR. */
export const scoreOcrText: TextScorer = (text) => {
  const { receipt: r } = parseReceiptText(text);
  const totals = computeTotals(r);
  return {
    score: scoreParse(r),
    recoveryItems: r.items.flatMap((i, index) => i.lineTotalCents === null && i.rowKind !== "ambiguous" && i.rowKind !== "return" && i.rowKind !== "adjustment"
      ? [{ index, description: i.description }] : []),
    good: r.items.length > 0 && r.receiptTotalCents !== null && totals.ok && totals.value.mismatchCents === 0 && !r.uncertainFields?.some((field) => field === "charges" || field === "items" || field === "total" || field === "discount") && !r.items.some((i) => i.flagged || i.lineTotalCents === null),
  };
};
