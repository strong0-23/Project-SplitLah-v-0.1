import { computeTotals } from "./bill";
import { isSafeCents } from "./money";
import { receiptReviewReasons, type ReceiptReviewReason } from "./receipt-quality";
import type { Receipt } from "./types";

export interface ReceiptAssessment {
  status: "Ready" | "Needs check" | "Failed";
  reasons: ReceiptReviewReason[];
  failureKind?: "runtime" | "insufficient";
}

/** Status describes a usable split, not confidence or an engine's financial correctness score. */
export function assessReceipt(receipt: Receipt): ReceiptAssessment {
  const reasons = receiptReviewReasons(receipt);
  if (receipt.extractionFailure?.kind === "runtime")
    return {
      status: "Failed",
      failureKind: "runtime",
      reasons: [
        {
          path: "extraction",
          code: "runtime",
          message:
            receipt.extractionFailure.message ||
            "Recognition could not complete. Try again or enter the receipt manually.",
        },
        ...reasons,
      ],
    };
  if (
    !receipt.items.some(
      (item) =>
        item.description.trim() &&
        (isSafeCents(item.lineTotalCents) ||
          ((item.rowKind === "return" || item.rowKind === "adjustment") &&
            typeof item.lineTotalCents === "number" &&
            isSafeCents(-item.lineTotalCents))),
    )
  )
    return {
      status: "Failed",
      failureKind: "insufficient",
      reasons: [
        {
          path: "items",
          code: "insufficient",
          message:
            "Recognition did not provide a usable product with a known full line amount. Enter the missing product details or try another photo.",
        },
        ...reasons,
      ],
    };
  const totals = computeTotals(receipt);
  if (!totals.ok)
    reasons.push(
      ...totals.errors.map((message) => ({
        path: "calculation",
        code: "invalid-calculation",
        message,
      })),
    );
  else if (totals.value.mismatchCents !== null && totals.value.mismatchCents !== 0)
    reasons.push({
      path: "total",
      code: "reconciliation",
      message:
        "The calculated total differs from the printed payable total. Check products, discounts and charges.",
    });
  return { status: reasons.length ? "Needs check" : "Ready", reasons };
}
