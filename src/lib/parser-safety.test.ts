import { describe, expect, it } from "vitest";
import { parseReceiptText, splitItemLabel } from "./parser";

describe("parser safety and field provenance", () => {
  it("keeps a missing quantity unknown instead of confirming the display placeholder", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Amount\nCoffee 4.00\nTotal 4.00");
    const item = receipt.items[0]!;
    expect(item.quantity).toBe(1);
    expect(item.quantityExact).toBeNull();
    expect(item.lineTotalCents).toBe(400);
    expect(item.evidence?.quantity).toMatchObject({ origin: "unknown", needsReview: true });
    expect(item.evidence?.lineTotalCents).toMatchObject({ origin: "observed", needsReview: false });
    expect(item.flagged).toBe(true);
  });

  it("retains observed integer quantities separately from uncertainty", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Qty Amount\nCoffee 2 8.00\nTotal 8.00");
    expect(receipt.items[0]).toMatchObject({ quantity: 2, quantityExact: { numerator: 2, denominator: 1 }, lineTotalCents: 800 });
    expect(receipt.items[0]!.evidence?.quantity).toMatchObject({ origin: "observed", needsReview: false });
  });

  it("does not flag a fully observed product solely because optional unit price is absent", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Qty Amount\nCoffee 2 8.00\nTotal 8.00");
    expect(receipt.items[0]!.unitPriceCents).toBeNull();
    expect(receipt.items[0]!.evidence?.unitPriceCents?.origin).toBe("unknown");
    expect(receipt.items[0]!.flagged).toBe(false);
    expect(receipt.uncertainFields).not.toContain("items");
  });

  it("does not turn an OCR quantity glyph into an observed one", () => {
    const split = splitItemLabel("Coffee I");
    expect(split).toMatchObject({ quantity: 1, quantityObserved: false, qtyUncertain: true });
    const { receipt } = parseReceiptText("Example Store\nDescription Qty Amount\nCoffee I 4.00\nTotal 4.00");
    expect(receipt.items[0]!.quantityExact).toBeNull();
    expect(receipt.items[0]!.evidence?.quantity?.origin).toBe("unknown");
  });

  it("retains all existing fields and flags a conflicting identifiable price relationship", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Unit Price Qty Amount\nCoffee 3.00 2 7.00\nTotal 7.00");
    const item = receipt.items[0]!;
    expect(item).toMatchObject({ description: "Coffee", quantity: 2, unitPriceCents: 300, lineTotalCents: 700, flagged: true });
    for (const field of ["quantity", "unitPriceCents", "lineTotalCents"] as const) expect(item.evidence?.[field]?.needsReview).toBe(true);
    expect(item.evidence?.lineTotalCents?.reasons.join(" ")).toMatch(/does not match/);
  });

  it("records an agreeing relationship without converting defaults into evidence", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Unit Price Qty Amount\nCoffee 3.00 2 6.00\nTotal 6.00");
    expect(receipt.items[0]!.evidence?.quantity).toMatchObject({ origin: "observed", needsReview: false });
    expect(receipt.items[0]!.unitPriceCents).toBe(300);
    expect(receipt.evidence?.currency).toMatchObject({ origin: "defaulted", needsReview: true });
  });

  it("keeps absent discounts and charges distinct from confirmed zero", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Qty Amount\nCoffee 1 4.00\nTotal 4.00");
    expect(receipt.discountCents).toBe(0);
    expect(receipt.evidence?.discountCents?.origin).toBe("unknown");
    expect(receipt.evidence?.service).toMatchObject({ origin: "unknown", needsReview: true });
    expect(receipt.evidence?.gst).toMatchObject({ origin: "unknown", needsReview: true });
  });

  it("keeps a savings summary separate from an unconfirmed discount adjustment", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Qty Amount\nCoffee 1 4.00\nTotal savings 1.00\nTotal 4.00");
    // 1b intentionally replaces the 1a legacy discount=100 inference: a savings
    // summary alone cannot establish that another adjustment must be deducted.
    expect(receipt.discountCents).toBe(0);
    expect(receipt.evidence?.discountCents).toMatchObject({ origin: "unknown", needsReview: true });
    expect(receipt.uncertainFields).toContain("discount");
  });

  it("records explicitly printed zero charges and discount as observed", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Qty Amount\nCoffee 1 4.00\nDiscount 0.00\nService 0.00\nGST 0.00\nTotal 4.00");
    expect(receipt.evidence?.discountCents?.origin).toBe("observed");
    expect(receipt.evidence?.service?.origin).toBe("observed");
    expect(receipt.evidence?.gst?.origin).toBe("observed");
  });

  it("distinguishes printed charge rates from retained application preferences", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Qty Amount\nCoffee 1 10.00\nService 10% 1.00\nGST 0.99\nTotal 11.99");
    expect(receipt.serviceRateBp).toBe(1000);
    expect(receipt.evidence?.serviceRateBp).toMatchObject({ origin: "observed" });
    expect(receipt.evidence?.gstRateBp).toMatchObject({ origin: "defaulted" });
    expect(receipt.evidence?.gstRateBp?.sources).toEqual([]);
  });

  it("marks arithmetic-only GST inclusion as inference that needs confirmation", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Qty Amount\nCoffee 1 10.00\nGST 0.90\nTotal 10.00");
    expect(receipt.gstInclusive).toBe(true);
    expect(receipt.evidence?.gstInclusive).toMatchObject({ origin: "inferred", needsReview: true });
    expect(receipt.uncertainFields).toContain("charges");
  });

  it("retains an explicit included-GST statement as printed evidence", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Qty Amount\nCoffee 1 10.00\nGST included 0.90\nTotal 10.00");
    expect(receipt.evidence?.gstInclusive).toMatchObject({ origin: "observed" });
    expect(receipt.evidence?.gstInclusive?.sources[0]?.text).toBe("GST included 0.90");
  });

  it("does not manufacture printed total evidence from a balanced sum", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Qty Amount\nCoffee 1 4.00");
    expect(receipt.receiptTotalCents).toBeNull();
    expect(receipt.evidence?.total).toMatchObject({ origin: "unknown", needsReview: true, sources: [] });
  });

  it("preserves original line indices and both sources of supported split rows", () => {
    const { receipt } = parseReceiptText("Example Store\n\nDescription Qty Amount\nCoffee\n2 8.00\nTotal 8.00");
    const sources = receipt.items[0]!.evidence?.lineTotalCents?.sources;
    expect(sources?.map((s) => s.lineIndices)).toEqual([[3], [4]]);
    expect(sources?.map((s) => s.text)).toEqual(["Coffee", "2 8.00"]);
  });

  it("keeps unreadable numeric values unknown and reviewable", () => {
    const { receipt } = parseReceiptText("Example Store\nDescription Unit Price Qty Amount\nConcert Pass 12.00 ? BAD\nTotal 24.00");
    expect(receipt.items[0]).toMatchObject({ description: "Concert Pass", quantity: 1, quantityExact: null, lineTotalCents: null, flagged: true });
    expect(receipt.items[0]!.evidence?.lineTotalCents).toMatchObject({ origin: "unknown", needsReview: true });
  });
});
