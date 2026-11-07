import { describe, expect, it } from "vitest";
import {
  confirmItemField,
  confirmReceiptField,
  effectiveQuantity,
  itemFieldNeedsReview,
  makeEvidence,
  receiptReviewReasons,
  updateItemWithEvidence,
  updateReceiptWithEvidence,
} from "./receipt-quality";
import type { Receipt, ReceiptItem } from "./types";
import { saveSession } from "./storage";

export const qualityItem = (): ReceiptItem => ({
  id: "synthetic-item",
  description: "Example 500ml 2-pack",
  quantity: 2,
  quantityExact: { numerator: 2, denominator: 1 },
  lineTotalCents: 600,
  rowKind: "product",
  evidence: {
    description: makeEvidence("observed"),
    quantity: makeEvidence("observed"),
    lineTotalCents: makeEvidence("observed"),
    role: makeEvidence("observed"),
  },
});
export const qualityReceipt = (): Receipt => ({
  merchant: "Synthetic shop",
  currency: "SGD",
  items: [qualityItem()],
  printedSubtotalCents: null,
  printedNetSubtotalCents: null,
  discountCents: 0,
  chargeMode: "receipt",
  serviceEnabled: false,
  serviceRateBp: 0,
  serviceAmountCents: null,
  gstEnabled: false,
  gstRateBp: 900,
  gstAmountCents: null,
  gstInclusive: false,
  receiptTotalCents: 600,
  evidence: Object.fromEntries(
    ["currency", "discountCents", "service", "gst", "gstInclusive", "total"].map((field) => [
      field,
      makeEvidence("observed"),
    ]),
  ),
});

describe("receipt provenance and uncertainty", () => {
  it("marks inferred, defaulted and unknown evidence pending, without sharing mutable arrays", () => {
    const sources = [{ kind: "text" as const, text: "synthetic source" }];
    const reasons = ["Check this field"];
    for (const origin of ["unknown", "inferred", "defaulted"] as const)
      expect(makeEvidence(origin).needsReview).toBe(true);
    const result = makeEvidence("observed", sources, reasons);
    sources[0]!.text = "changed";
    reasons.push("extra");
    expect(result.sources[0]!.text).toBe("synthetic source");
    expect(result.reasons).toEqual(["Check this field"]);
  });

  it("never treats an unknown quantity placeholder as known", () => {
    const item = {
      ...qualityItem(),
      quantity: 1,
      quantityExact: null,
      evidence: { quantity: makeEvidence("unknown") },
    };
    expect(effectiveQuantity(item)).toBeNull();
    expect(itemFieldNeedsReview(item, "quantity")).toBe(true);
    expect(confirmItemField(item, "quantity")).toBe(item);
  });

  it("keeps a default quantity visibly pending until the user explicitly confirms it", () => {
    const item = {
      ...qualityItem(),
      quantity: 1,
      quantityExact: { numerator: 1, denominator: 1 },
      evidence: { ...qualityItem().evidence, quantity: makeEvidence("defaulted") },
    };
    expect(effectiveQuantity(item)).toBeNull();
    const confirmed = confirmItemField(item, "quantity");
    expect(effectiveQuantity(confirmed)).toBe(1);
    expect(confirmed.evidence?.quantity?.previousOrigin).toBe("defaulted");
  });

  it("requires review of missing financial provenance even if legacy values balance", () => {
    const item = { ...qualityItem(), evidence: undefined, flagged: true };
    expect(itemFieldNeedsReview(item, "description")).toBe(true);
    expect(itemFieldNeedsReview(item, "quantity")).toBe(true);
    expect(itemFieldNeedsReview(item, "lineTotalCents")).toBe(true);
    expect(itemFieldNeedsReview(item, "unitPriceCents")).toBe(false);
  });

  it("confirms only a valid edited field and retains unrelated source evidence and flags", () => {
    const quantity = makeEvidence(
      "inferred",
      [{ kind: "text", text: "synthetic qty" }],
      ["Auto-filled, please check"],
    );
    const item = {
      ...qualityItem(),
      flagged: true,
      evidence: { ...qualityItem().evidence, quantity, lineTotalCents: makeEvidence("unknown") },
    };
    const next = updateItemWithEvidence(item, { description: "Updated identity" });
    expect(next.evidence?.description?.origin).toBe("user-confirmed");
    expect(next.evidence?.quantity).toEqual(quantity);
    expect(next.flagged).toBe(true);
    expect(item.description).toBe("Example 500ml 2-pack");
  });

  it("accepts explicit user quantity entry even when it matches a legacy display placeholder", () => {
    const item = {
      ...qualityItem(),
      quantity: 1,
      quantityExact: null,
      evidence: { ...qualityItem().evidence, quantity: makeEvidence("unknown") },
    };
    const next = updateItemWithEvidence(item, { quantity: 1 });
    expect(next.quantityExact).toEqual({ numerator: 1, denominator: 1 });
    expect(next.evidence?.quantity?.origin).toBe("user-confirmed");
    expect(effectiveQuantity(next)).toBe(1);
  });

  it("preserves an exact user-entered fractional quantity", () => {
    const next = updateItemWithEvidence(qualityItem(), { quantity: 0.375 });
    expect(next.quantityExact).toEqual({ numerator: 3, denominator: 8 });
    expect(effectiveQuantity(next)).toBe(0.375);
  });

  it("does not clear an invalid field through confirmation or invalid editing", () => {
    const item = { ...qualityItem(), lineTotalCents: null, flagged: true };
    expect(confirmItemField(item, "lineTotalCents")).toBe(item);
    const next = updateItemWithEvidence(item, { lineTotalCents: Number.NaN });
    expect(next.evidence?.lineTotalCents?.needsReview).toBe(true);
    expect(next.flagged).toBe(true);
  });

  it("retains original sources and the pre-confirmation origin", () => {
    const source = { kind: "geometry" as const, attemptIndex: 3, boxIndices: [2, 3] };
    const item = {
      ...qualityItem(),
      evidence: { ...qualityItem().evidence, quantity: makeEvidence("inferred", [source]) },
    };
    const next = confirmItemField(item, "quantity");
    expect(next.evidence?.quantity?.sources[0]).toEqual(source);
    expect(next.evidence?.quantity?.sources[1]?.kind).toBe("user");
    expect(next.evidence?.quantity?.previousOrigin).toBe("inferred");
  });

  it("does not erase an unrelated receipt uncertainty when one field is edited", () => {
    const receipt = qualityReceipt();
    receipt.evidence!.gst = makeEvidence("unknown", [
      { kind: "text", text: "unresolved tax label" },
    ]);
    const next = updateReceiptWithEvidence(receipt, { merchant: "New merchant" });
    expect(next.evidence?.merchant?.origin).toBe("user-confirmed");
    expect(next.evidence?.gst).toEqual(receipt.evidence!.gst);
    expect(receiptReviewReasons(next).some((reason) => reason.path === "gst")).toBe(true);
  });

  it("does not confirm an incomplete enabled charge by editing its rate in receipt mode", () => {
    const receipt = { ...qualityReceipt(), serviceEnabled: true, serviceAmountCents: null };
    const next = updateReceiptWithEvidence(receipt, { serviceRateBp: 1000 });
    expect(next.evidence?.service).toEqual(receipt.evidence?.service);
    expect(receiptReviewReasons(next)).toContainEqual(
      expect.objectContaining({ path: "service", code: "invalid-or-missing" }),
    );
    expect(next.evidence?.serviceRateBp?.origin).toBe("user-confirmed");
    expect(confirmReceiptField(next, "service")).toBe(next);
  });

  it("records confirmed missing printed total as absence, never zero or a tender suggestion", () => {
    const receipt = { ...qualityReceipt(), receiptTotalCents: null, suggestedTotalCents: 999 };
    expect(receiptReviewReasons(receipt).some((reason) => reason.path === "total")).toBe(true);
    const next = confirmReceiptField(receipt, "total");
    expect(next.receiptTotalCents).toBeNull();
    expect(next.suggestedTotalCents).toBe(999);
    expect(next.evidence?.total?.sources.at(-1)).toMatchObject({
      kind: "user",
      observedValue: null,
    });
    expect(receiptReviewReasons(next).some((reason) => reason.path === "total")).toBe(false);
  });

  it("reports specific price relationships even after quantity and price confirmations", () => {
    const item = {
      ...qualityItem(),
      unitPriceCents: 200,
      evidence: { ...qualityItem().evidence, unitPriceCents: makeEvidence("user-confirmed") },
    };
    const receipt = { ...qualityReceipt(), items: [item] };
    expect(receiptReviewReasons(receipt)).toContainEqual(
      expect.objectContaining({ path: "items[0].pricingBasis", code: "price-relationship" }),
    );
  });

  it("keeps ambiguous row roles inspectable and does not clear them with a generic confirmation", () => {
    const receipt = {
      ...qualityReceipt(),
      rows: [
        {
          id: "row",
          role: "ambiguous" as const,
          text: "Synthetic offer",
          amountCents: 200,
          sources: [],
          needsReview: true,
        },
      ],
    };
    expect(confirmReceiptField(receipt, "rows")).toBe(receipt);
    expect(receiptReviewReasons(receipt)).toContainEqual(expect.objectContaining({ path: "rows" }));
  });

  it("keeps optional absent unit price unknown without requiring a correction", () => {
    const item = qualityItem();
    item.unitPriceCents = null;
    item.evidence!.unitPriceCents = makeEvidence("unknown");
    expect(itemFieldNeedsReview(item, "unitPriceCents")).toBe(false);
  });

  it("does not let a charge amount edit confirm an unrelated GST inclusion decision", () => {
    const receipt = qualityReceipt();
    receipt.gstEnabled = true;
    receipt.gstAmountCents = null;
    receipt.evidence!.gst = makeEvidence("unknown");
    receipt.evidence!.gstInclusive = makeEvidence("inferred");
    const next = updateReceiptWithEvidence(receipt, { gstAmountCents: 54 });
    expect(next.evidence?.gst?.origin).toBe("user-confirmed");
    expect(next.evidence?.gstInclusive?.origin).toBe("inferred");
    expect(receiptReviewReasons(next)).toContainEqual(
      expect.objectContaining({ path: "gstInclusive" }),
    );
  });

  it("reviews preferred rates only when their enabled charge uses percentage mode", () => {
    const receipt = qualityReceipt();
    receipt.evidence!.gstRateBp = makeEvidence("defaulted");
    expect(receiptReviewReasons(receipt).some((reason) => reason.path === "gstRateBp")).toBe(false);
    receipt.chargeMode = "percentage";
    receipt.gstEnabled = true;
    expect(receiptReviewReasons(receipt)).toContainEqual(
      expect.objectContaining({ path: "gstRateBp" }),
    );
    const next = updateReceiptWithEvidence(receipt, { gstRateBp: 800 });
    expect(next.evidence?.gstRateBp?.origin).toBe("user-confirmed");
    expect(receiptReviewReasons(next).some((reason) => reason.path === "gstRateBp")).toBe(false);
  });

  it("does not confirm missing charges just by changing the charge entry mode", () => {
    const receipt = qualityReceipt();
    receipt.evidence!.service = makeEvidence("unknown");
    receipt.evidence!.gst = makeEvidence("unknown");
    const next = updateReceiptWithEvidence(receipt, { chargeMode: "percentage" });
    expect(next.evidence?.service).toEqual(receipt.evidence!.service);
    expect(next.evidence?.gst).toEqual(receipt.evidence!.gst);
    expect(receiptReviewReasons(next).map((reason) => reason.path)).toEqual(
      expect.arrayContaining(["service", "gst"]),
    );
  });

  it("rechecks active amounts and rates when changing the charge mode", () => {
    const receipt = qualityReceipt();
    receipt.serviceEnabled = true;
    receipt.serviceAmountCents = 60;
    receipt.evidence!.serviceRateBp = makeEvidence("user-confirmed");
    const next = updateReceiptWithEvidence(receipt, { chargeMode: "percentage" });
    expect(next.evidence?.service?.needsReview).toBe(true);
    expect(next.evidence?.serviceRateBp?.needsReview).toBe(true);
    expect(next.evidence?.gst).toEqual(receipt.evidence?.gst);
    expect(next.serviceAmountCents).toBe(60);
  });

  it("rechecks stale charge and tax decisions when GST is re-enabled", () => {
    const receipt = qualityReceipt();
    receipt.chargeMode = "percentage";
    receipt.evidence!.gstRateBp = makeEvidence("user-confirmed");
    const next = updateReceiptWithEvidence(receipt, { gstEnabled: true });
    expect(next.evidence?.gst?.needsReview).toBe(true);
    expect(next.evidence?.gstInclusive?.needsReview).toBe(true);
    expect(next.evidence?.gstRateBp?.needsReview).toBe(true);
    expect(next.evidence?.service).toEqual(receipt.evidence?.service);
  });

  it("does not reuse a charge confirmation after changing its calculation rate or GST basis", () => {
    const receipt = qualityReceipt();
    receipt.chargeMode = "percentage";
    receipt.serviceEnabled = true;
    const rateEdited = updateReceiptWithEvidence(receipt, { serviceRateBp: 1000 });
    expect(rateEdited.evidence?.serviceRateBp?.origin).toBe("user-confirmed");
    expect(rateEdited.evidence?.service?.needsReview).toBe(true);
    receipt.chargeMode = "receipt";
    receipt.gstEnabled = true;
    receipt.gstAmountCents = 54;
    const basisEdited = updateReceiptWithEvidence(receipt, { gstInclusive: true });
    expect(basisEdited.evidence?.gstInclusive?.origin).toBe("user-confirmed");
    expect(basisEdited.evidence?.gst?.needsReview).toBe(true);
    expect(basisEdited.gstAmountCents).toBe(54);
  });

  it("records explicit quantity-unit edits without making a wrong pricing relationship pass", () => {
    const item = qualityItem();
    item.unitOfMeasure = "g";
    item.unitPriceCents = 300;
    item.priceBasis = { quantity: { numerator: 1, denominator: 1 }, unit: "kg" };
    item.evidence!.unitPriceCents = makeEvidence("observed");
    item.evidence!.pricingBasis = makeEvidence("unknown");
    const next = updateItemWithEvidence(item, { unitOfMeasure: "ml" });
    expect(next.evidence?.pricingBasis?.origin).toBe("user-confirmed");
    expect(receiptReviewReasons({ ...qualityReceipt(), items: [next] })).toContainEqual(
      expect.objectContaining({ path: "items[0].pricingBasis", code: "price-relationship" }),
    );
  });

  it("persists long typing without discarding original recognition or recovery sources", () => {
    const originalSources = [
      {
        kind: "text" as const,
        engine: "text" as const,
        lineIndices: [1],
        text: "Synthetic original reading",
      },
      {
        kind: "geometry" as const,
        engine: "tesseract" as const,
        attemptIndex: 1,
        boxIndices: [3],
        text: "Synthetic alternate reading",
      },
    ];
    let item = qualityItem();
    item.evidence!.description = makeEvidence("observed", originalSources);
    for (let length = 1; length <= 80; length++)
      item = updateItemWithEvidence(item, { description: "x".repeat(length) });
    const evidence = item.evidence!.description!;
    expect(evidence.sources.slice(0, 2)).toEqual(originalSources);
    expect(evidence.sources).toHaveLength(3);
    expect(evidence.previousOrigin).toBe("observed");
    expect(evidence.sources.at(-1)?.observedValue).toBe("x".repeat(80));
    expect(
      saveSession({
        receipt: { ...qualityReceipt(), items: [item] },
        participants: [],
        assignments: {},
      }),
    ).toBe(true);
  });

  it("bounds older user action history while retaining non-user evidence and the original origin", () => {
    const source = { kind: "text" as const, text: "Synthetic source" };
    let item = qualityItem();
    item.evidence!.description = makeEvidence("inferred", [source]);
    for (let index = 0; index < 80; index++) {
      item = updateItemWithEvidence(item, { description: `Synthetic revision ${index}` });
      item = confirmItemField(item, "description");
    }
    expect(item.evidence!.description!.sources[0]).toEqual(source);
    expect(item.evidence!.description!.sources.length).toBeLessThanOrEqual(30);
    expect(item.evidence!.description!.previousOrigin).toBe("inferred");
    expect(
      saveSession({
        receipt: { ...qualityReceipt(), items: [item] },
        participants: [],
        assignments: {},
      }),
    ).toBe(true);
  });
});
