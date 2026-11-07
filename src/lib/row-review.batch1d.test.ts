import { describe, expect, it } from "vitest";
import { emptyReceipt } from "./defaults";
import { confirmReceiptField, makeEvidence, reconcileRowReviewEvidence, rowReviewState, updateReceiptWithEvidence } from "./receipt-quality";
import type { FieldEvidence, Receipt } from "./types";

const row = { id: "synthetic", role: "rounding" as const, text: "Cash rounding -0.10", amountCents: -10, needsReview: false,
  sources: [{ kind: "text" as const, text: "Cash rounding -0.10", engine: "tesseract" as const, attemptIndex: 0, lineIndices: [2] }] };
const receipt = (evidence: FieldEvidence): Receipt => ({ ...emptyReceipt(), rows: [structuredClone(row)], evidence: { rows: evidence } });

describe("scoped row-review state invariants", () => {
  it.each([
    "Some receipt rows have an unresolved financial role; inspect their retained text.",
    "Check the highlighted receipt row classifications and associations.",
  ])("derives a resolved decision summary without deleting original source/history: %s", reason => {
    const evidence = makeEvidence("observed", row.sources, [reason]);
    evidence.sources.push({ kind: "user", text: "An earlier independent check.", observedValue: "reviewed" });
    const original = receipt(evidence), resolved = reconcileRowReviewEvidence(original);
    expect(rowReviewState(resolved)).toMatchObject({ unresolvedRows: false, independentNeedsReview: false });
    expect(resolved.evidence?.rows).toEqual({ ...evidence, needsReview: false, reasons: [] });
    expect(resolved.evidence?.rows?.sources).toEqual(evidence.sources);
    expect(original.evidence?.rows?.needsReview).toBe(true);
  });

  it.each([
    makeEvidence("observed", row.sources, ["Independent source association has not been checked."]),
    makeEvidence("unknown", row.sources),
    { ...makeEvidence("observed", row.sources), needsReview: true },
  ])("retains independent, unknown-origin and unstructured pending evidence until explicit confirmation", evidence => {
    const original = receipt(evidence), resolvedRows = updateReceiptWithEvidence(original, { rows: [{ ...row, sources: [...row.sources, { kind: "user", text: "Row checked." }] }] });
    expect(rowReviewState(resolvedRows).independentNeedsReview).toBe(true);
    expect(resolvedRows.evidence?.rows?.needsReview).toBe(true);
    expect(resolvedRows.evidence?.rows?.sources).toEqual(evidence.sources);
    const confirmed = confirmReceiptField(resolvedRows, "rows");
    expect(rowReviewState(confirmed)).toMatchObject({ unresolvedRows: false, independentNeedsReview: false });
    expect(confirmed.evidence?.rows?.sources.slice(0, -1)).toEqual(evidence.sources);
    expect(confirmed.evidence?.rows?.sources.at(-1)?.kind).toBe("user");
  });

  it("keeps a new unresolved row decision distinct from previously confirmed aggregate evidence", () => {
    let current = receipt(makeEvidence("user-confirmed", [{ kind: "user", text: "Previous rows checked." }]));
    current = updateReceiptWithEvidence(current, { rows: [{ ...row, needsReview: true }] });
    expect(rowReviewState(current)).toMatchObject({ unresolvedRows: true, independentNeedsReview: false });
    expect(confirmReceiptField(current, "rows")).toBe(current);
    current = updateReceiptWithEvidence(current, { rows: [row] });
    expect(rowReviewState(current)).toMatchObject({ unresolvedRows: false, independentNeedsReview: false });
    expect(current.evidence?.rows?.needsReview).toBe(false);
  });

  it("never lets resolving one rounding row clear another pending row or independent reason", () => {
    const original = receipt(makeEvidence("observed", row.sources, ["Check the highlighted receipt row classifications and associations.", "Independent layout check remains."]));
    original.rows = [{ ...row, needsReview: true }, { ...row, id: "other", role: "ambiguous", text: "Synthetic ambiguous row", amountCents: null, needsReview: true }];
    const next = updateReceiptWithEvidence(original, { rows: original.rows.map(current => current.id === row.id ? { ...current, needsReview: false } : current) });
    expect(next.rows![1]).toBe(original.rows[1]);
    expect(rowReviewState(next)).toMatchObject({ unresolvedRows: true, independentNeedsReview: true });
    expect(next.evidence?.rows?.reasons).toContain("Independent layout check remains.");
    expect(confirmReceiptField(next, "rows")).toBe(next);
  });
});
