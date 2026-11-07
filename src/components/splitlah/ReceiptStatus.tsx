import { assessReceipt } from "@/lib/receipt-status";
import type { FieldEvidence, Receipt } from "@/lib/types";
import { Notice } from "./ui";

export function ReceiptStatus({ receipt }: { receipt: Receipt }) {
  const assessment = assessReceipt(receipt);
  return <Notice tone={assessment.status === "Ready" ? "success" : assessment.status === "Failed" ? "error" : "warning"} title={assessment.status}>
    {assessment.status === "Ready" ? "Required fields are checked and the split can be prepared." : <ul className="list-disc pl-4">
      {assessment.reasons.map((reason, index) => <li key={`${reason.path}-${reason.code}-${index}`}>{/^items\[(\d+)\]/.test(reason.path) ? `Item ${Number(/^items\[(\d+)\]/.exec(reason.path)![1]) + 1}: ` : ""}{reason.message}</li>)}
    </ul>}
  </Notice>;
}

export function EvidenceNote({ evidence }: { evidence?: FieldEvidence | undefined }) {
  if (!evidence) return null;
  const label = evidence.origin === "saved-preference" ? "Saved preference — confirm for this receipt" : evidence.origin === "inferred" ? "Auto-filled, please check" : evidence.origin === "defaulted" ? "Default, please check" : evidence.origin === "unknown" ? "Unknown — enter or verify" : evidence.origin === "user-confirmed" ? "You confirmed this field" : evidence.origin === "calculated" ? "Calculated; not printed evidence" : evidence.needsReview ? "Read from receipt — please check" : "Read from receipt";
  return <div className="mt-1 text-xs text-muted-foreground"><p>{label}</p>
    {evidence.needsReview && evidence.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
    {!!evidence.sources.length && <details><summary>Source evidence</summary><ul>{evidence.sources.map((source, index) => <li key={index}>{source.text ?? source.kind}{source.attemptIndex !== undefined ? ` (reading ${source.attemptIndex + 1})` : ""}</li>)}</ul></details>}
  </div>;
}
