import { describe, expect, it } from "vitest";
import { confirmReceiptField, makeEvidence, updateReceiptWithEvidence } from "./receipt-quality";
import { assessReceipt } from "./receipt-status";
import type { Receipt, ReceiptItem } from "./types";

const item = (): ReceiptItem => ({
  id: "example",
  description: "Synthetic product",
  quantity: 1,
  quantityExact: { numerator: 1, denominator: 1 },
  lineTotalCents: 500,
  evidence: {
    description: makeEvidence("observed"),
    quantity: makeEvidence("observed"),
    lineTotalCents: makeEvidence("observed"),
  },
});
const receipt = (): Receipt => ({
  merchant: "",
  currency: "SGD",
  items: [item()],
  printedSubtotalCents: null,
  discountCents: 0,
  chargeMode: "receipt",
  serviceEnabled: false,
  serviceRateBp: 0,
  serviceAmountCents: null,
  gstEnabled: false,
  gstRateBp: 900,
  gstAmountCents: null,
  gstInclusive: false,
  receiptTotalCents: 500,
  evidence: Object.fromEntries(
    ["currency", "discountCents", "service", "gst", "gstInclusive", "total"].map((field) => [
      field,
      makeEvidence("observed"),
    ]),
  ),
});

describe("receipt status", () => {
  it("is Ready only when usable fields are known and reconciled; merchant is optional", () => {
    expect(assessReceipt(receipt())).toEqual({ status: "Ready", reasons: [] });
  });
  it("does not grant Ready because arithmetic balances while quantity is defaulted", () => {
    const value = receipt();
    value.items[0]!.evidence!.quantity = makeEvidence("defaulted");
    const result = assessReceipt(value);
    expect(result.status).toBe("Needs check");
    expect(result.reasons).toContainEqual(expect.objectContaining({ path: "items[0].quantity" }));
  });
  it("does not treat missing charge information as confirmed zero", () => {
    const value = receipt();
    value.evidence!.service = makeEvidence("unknown");
    expect(assessReceipt(value).status).toBe("Needs check");
    expect(assessReceipt(value).reasons.some((reason) => reason.path === "service")).toBe(true);
  });
  it("keeps a real mismatch pending even if every field was user-confirmed", () => {
    const value = receipt();
    value.receiptTotalCents = 600;
    expect(assessReceipt(value).reasons).toContainEqual(
      expect.objectContaining({ path: "total", code: "reconciliation" }),
    );
  });
  it("accepts explicit absence of printed total without inventing one", () => {
    const value = receipt();
    value.receiptTotalCents = null;
    expect(assessReceipt(value).status).toBe("Needs check");
    expect(assessReceipt(confirmReceiptField(value, "total")).status).toBe("Ready");
  });
  it("does not confirm total absence merely by clearing or invalidating the input", () => {
    for (const input of [null, Number.NaN]) {
      const value = updateReceiptWithEvidence(receipt(), { receiptTotalCents: input });
      expect(value.evidence?.total?.origin).toBe("unknown");
      expect(value.evidence?.total?.needsReview).toBe(true);
      expect(assessReceipt(value).status).toBe("Needs check");
      expect(assessReceipt(value).reasons).toContainEqual(
        expect.objectContaining({ path: "total" }),
      );
    }
    const cleared = updateReceiptWithEvidence(receipt(), { receiptTotalCents: null });
    expect(cleared.receiptTotalCents).toBeNull();
    expect(assessReceipt(confirmReceiptField(cleared, "total")).status).toBe("Ready");
  });
  it("distinguishes runtime failure from insufficient usable extraction", () => {
    const runtime = {
      ...receipt(),
      extractionFailure: {
        kind: "runtime" as const,
        message: "Recognition worker did not initialise.",
      },
    };
    expect(assessReceipt(runtime)).toMatchObject({ status: "Failed", failureKind: "runtime" });
    expect(assessReceipt(runtime).reasons[0]?.message).toBe(
      "Recognition worker did not initialise.",
    );
    const insufficient = receipt();
    insufficient.items[0]!.lineTotalCents = null;
    expect(assessReceipt(insufficient)).toMatchObject({
      status: "Failed",
      failureKind: "insufficient",
    });
    expect(assessReceipt({ ...receipt(), items: [] })).toMatchObject({
      status: "Failed",
      failureKind: "insufficient",
    });
  });
});
