import { describe, expect, it } from "vitest";
import { parseReceiptText, receiptSummaryEvidence } from "./parser";

const parse = (body: string) => parseReceiptText(`EXAMPLE MERCHANT\n${body}`).receipt;

describe("engine-independent receipt interpretation", () => {
  it("normalises OCR total labels while preserving product names and literal source", () => {
    const r = parse("Description Qty Amount\nT0TAL CARE 500ml 1 4.00\nT0TAI 4.00");
    expect(r.items[0]).toMatchObject({ description: "T0TAL CARE 500ml", lineTotalCents: 400 });
    expect(r.receiptTotalCents).toBe(400);
    expect(r.evidence?.total?.sources[0]?.text).toBe("T0TAI 4.00");
  });

  it("limits confusion substitutions to summary labels, never damaged amounts", () => {
    const r = parse("Description Qty Amount\nSOAP 1 10.00\nD1SC0UNT 2.00-\nT0TA| 8.00\nGST 1O.00");
    expect(r.discountCents).toBe(200);
    expect(r.receiptTotalCents).toBe(800);
    expect(r.gstAmountCents).toBeNull();
  });

  it("recognises a confused GST label without changing its numeric rate", () => {
    const r = parse("Description Qty Amount\nSOAP 1 10.00\nG5T 5% 0.50\nTotal 10.50");
    expect(r.gstAmountCents).toBe(50);
    expect(r.gstRateBp).toBe(500);
    const signed = parse("SOAP 1 10.00\nService -1.00\nGST 0.50- F\nTotal 8.50");
    expect(signed.serviceAmountCents).toBeNull();
    expect(signed.gstAmountCents).toBeNull();
    expect(signed.evidence?.service).toMatchObject({ origin: "unknown", needsReview: true });
    expect(signed.evidence?.gst).toMatchObject({ origin: "unknown", needsReview: true });
  });

  it("accepts financial-label separators without changing literal evidence or product text", () => {
    const r = parse("Description Qty Amount\nCODE; SOAP 1 10.00\nGST AMT;0.90\nService Charge= 1.00\nTotal:11.90");
    expect(r.items[0]!.description).toBe("CODE SOAP");
    expect(r.gstAmountCents).toBe(90);
    expect(r.serviceAmountCents).toBe(100);
    expect(r.receiptTotalCents).toBe(1190);
    expect(r.evidence?.gst?.sources[0]?.text).toBe("GST AMT;0.90");
  });

  it("accepts an isolated currency marker only after a complete financial label", () => {
    const r = parse("SOAP 1 10.00\nTotal GST S $0.90\nService Charge SGD $1.00\nTotal S $11.90");
    expect(r.gstAmountCents).toBe(90);
    expect(r.serviceAmountCents).toBe(100);
    expect(r.receiptTotalCents).toBe(1190);
    expect(r.evidence?.gst?.sources[0]?.text).toBe("Total GST S $0.90");
  });

  it("keeps a savings summary informational without an independent adjustment", () => {
    const r = parse("SOAP 1 8.00\nTotal savings 2.00\nTotal 8.00");
    expect(r.discountCents).toBe(0);
    expect(r.evidence?.discountCents).toMatchObject({ origin: "unknown", needsReview: true });
    expect(r.rows?.find((row) => row.text === "Total savings 2.00")?.role).toBe("summary");
  });

  it("deducts independent discount rows once when their savings summary repeats them", () => {
    const r = parse("SOAP 1 10.00\nDiscount 2.00-\nTotal savings 2.00\nTotal 8.00");
    expect(r.discountCents).toBe(200);
    expect(r.evidence?.discountCents?.origin).toBe("observed");
  });

  it("retains purchased offer descriptions with punctuation and package sizes", () => {
    const r = parse("Description Qty Amount\n2.FOR JUICE 500ml 1 6.00\n2-FOR SOAP 2-pack 1 4.00\n2 FOR TEA 1 3.00\nTotal 13.00");
    expect(r.items.map((item) => item.description)).toEqual(["2.FOR JUICE 500ml", "2-FOR SOAP 2-pack", "2 FOR TEA"]);
    expect(r.discountCents).toBe(0);
  });

  it("does not turn a bare positive offer into a product or discount", () => {
    const r = parse("SOAP 1 8.00\n2.FOR $8.00\nTotal 8.00");
    expect(r.items).toHaveLength(1);
    expect(r.discountCents).toBe(0);
    expect(r.rows?.find((row) => row.text === "2.FOR $8.00")?.role).toBe("heading");
  });

  it("retains an unsupported signed offer as an ambiguous financial row", () => {
    const r = parse("SOAP 1 10.00\n2-FOR $8.00 2.00-\nTotal 8.00");
    expect(r.discountCents).toBe(0);
    expect(r.rows?.find((row) => row.text.includes("2-FOR"))).toMatchObject({ role: "ambiguous", amountCents: -200, needsReview: true });
  });

  it("records a supported separately signed offer adjustment with inferred role and review", () => {
    // 1d: an explicit multiplication establishes the purchased quantity.
    const r = parse("2 x SOAP 10.00\n2 FOR $8.00 2.00-\nTotal savings 2.00\nTotal 8.00");
    expect(r.discountCents).toBe(200);
    expect(r.evidence?.discountCents).toMatchObject({ origin: "inferred", needsReview: true });
  });

  it("retains the original unheaded offer case without unsupported quantity certainty or deduction", () => {
    const r = parse("SOAP 2 10.00\n2 FOR $8.00 2.00-\nTotal savings 2.00\nTotal 8.00");
    expect(r.items[0]).toMatchObject({ description: "SOAP 2", quantityExact: null, lineTotalCents: 1000, flagged: true });
    expect(r.discountCents).toBe(0);
    expect(r.evidence?.discountCents?.needsReview).toBe(true);
    expect(r.rows?.find(row => row.text === "2 FOR $8.00 2.00-")).toMatchObject({ role: "ambiguous", amountCents: -200, needsReview: true });
  });

  it("does not turn an unexplained negative product into a discount", () => {
    const r = parse("SOAP 1 -4.00\nTotal 4.00");
    expect(r.discountCents).toBe(0);
    expect(r.items[0]).toMatchObject({ lineTotalCents: null, rowKind: "ambiguous", flagged: true });
  });

  it("retains an explicitly identified return as a signed product credit", () => {
    const r = parse("Return SOAP 1 -4.00\nTotal 0.00");
    expect(r.items[0]).toMatchObject({ description: "SOAP 1", quantity: 1, quantityExact: null, lineTotalCents: -400, rowKind: "return", flagged: true });
    expect(r.discountCents).toBe(0);
    expect(parse("Return SOUP 5.00- F").items[0]).toMatchObject({ description: "SOUP", lineTotalCents: -500, rowKind: "return" });
  });

  it("retains a supported product after an apparent total rather than discarding the remainder", () => {
    const r = parse("1 x SOAP 4.00\nTotal 4.00\n2 x TEA 3.00\nPayNow 7.00");
    expect(r.items.map((item) => item.description)).toEqual(["SOAP", "TEA"]);
    expect(r.receiptTotalCents).toBe(400);
    expect(r.rows?.find((row) => row.text === "PayNow 7.00")?.role).toBe("payment");
  });

  it("retains the original unheaded post-total numeric row for review without inventing its role", () => {
    const r = parse("SOAP 1 4.00\nTotal 4.00\nTEA 2 3.00\nPayNow 7.00");
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ description: "SOAP 1", quantityExact: null, lineTotalCents: 400 });
    expect(r.receiptTotalCents).toBe(400);
    expect(r.rows?.find(row => row.text === "TEA 2 3.00")).toMatchObject({ role: "ambiguous", amountCents: 300, needsReview: true, sources: [{ kind: "text", text: "TEA 2 3.00", lineIndices: [3] }] });
    expect(r.rows?.find(row => row.text === "PayNow 7.00")?.role).toBe("payment");
  });

  it("does not classify an unknown post-summary amount as a product", () => {
    const r = parse("SOAP 1 4.00\nTotal 4.00\nUNKNOWN LABEL 3.00");
    expect(r.items).toHaveLength(1);
    expect(r.rows?.find((row) => row.text === "UNKNOWN LABEL 3.00")).toMatchObject({ role: "ambiguous", needsReview: true });
  });

  it("preserves numeric identifiers while separating explicit unit/quantity/amount columns", () => {
    const r = parse("Description Unit($) Qty Amount\nMODEL 42 500ml 3.00 2 6.00\nTotal 6.00");
    expect(r.items[0]).toMatchObject({ description: "MODEL 42 500ml", quantity: 2, unitPriceCents: 300, lineTotalCents: 600 });
    expect(parse("Noodles No 8 3.50").items[0]).toMatchObject({ description: "Noodles No 8", quantityExact: null, flagged: true });
    // 1c: without a heading/multiplication token, do not assume a numeric prefix
    // is quantity or remove it from the product's identity.
    expect(parse("1 Noodles No 8 3.50").items[0]).toMatchObject({ description: "1 Noodles No 8", quantityExact: null, lineTotalCents: 350, flagged: true });
    expect(parse("1 x Noodles No 8 3.50").items[0]).toMatchObject({ description: "Noodles No 8", quantityExact: { numerator: 1, denominator: 1 } });
    expect(parse("Item Bag 2.00").items[0]).toMatchObject({ description: "Item Bag", lineTotalCents: 200 });
  });

  it("supports quantity-before-unit-price column order", () => {
    const r = parse("Description Qty Unit Price Amount\nMODEL 42 2 3.00 6.00\nTotal 6.00");
    expect(r.items[0]).toMatchObject({ description: "MODEL 42", quantity: 2, unitPriceCents: 300, lineTotalCents: 600 });
  });

  it("accepts a finite quantity-label confusion only in a complete unit/amount heading", () => {
    const r = parse("Unit($) qiy Amount\nCONCERT 12.00 2 24.00\nTotal 24.00");
    expect(r.items[0]).toMatchObject({ description: "CONCERT", quantity: 2, unitPriceCents: 1200, lineTotalCents: 2400 });
    expect(r.items[0]!.evidence?.quantity?.origin).toBe("observed");
  });

  it("validates fractional measured quantities using an explicit compatible pricing basis", () => {
    const r = parse("Description Qty(g) Unit Price($/kg) Amount\nLOOSE TEA 250 1.00 0.25\nTotal 0.25");
    expect(r.items[0]).toMatchObject({ quantityExact: { numerator: 250, denominator: 1 }, unitOfMeasure: "g", priceBasis: { quantity: { numerator: 1, denominator: 1 }, unit: "kg" }, lineTotalCents: 25, flagged: false });
  });

  it("retains exact fractional quantities and applies no quantity rounding", () => {
    const r = parse("Description Unit($) Qty Amount\nLOOSE TEA 5.00 1/2 2.50\nTotal 2.50");
    expect(r.items[0]).toMatchObject({ quantity: 0.5, quantityExact: { numerator: 1, denominator: 2 }, lineTotalCents: 250, flagged: false });
  });

  it("suggests a missing quantity only from exact, identified same-row prices with retained review", () => {
    const r = parse("Description Unit($) Qty Amount\nCOFFEE 3.00 ? 6.00\nTotal 6.00");
    expect(r.items[0]).toMatchObject({ description: "COFFEE", quantity: 2, quantityExact: { numerator: 2, denominator: 1 }, unitPriceCents: 300, lineTotalCents: 600, flagged: true });
    expect(r.items[0]!.evidence?.quantity).toMatchObject({ origin: "inferred", needsReview: true });
    expect(r.items[0]!.evidence?.quantity?.reasons.join(" ")).toMatch(/auto-filled, please check/);
  });

  it("does not suggest quantities when discount scope or tax basis is unresolved", () => {
    const discount = parse("Description Unit($) Qty Amount\nCOFFEE 3.00 ? 6.00\nDiscount 1.00-\nTotal 5.00");
    expect(discount.items[0]!.quantityExact).toBeNull();
    const tax = parse("Description Unit($) Qty Amount\nUnit prices exclude GST\nLine amount includes GST\nCOFFEE 3.00 ? 6.00\nTotal 6.00");
    expect(tax.items[0]!.quantityExact).toBeNull();
    const reverse = parse("Description Unit (incl GST) Qty Amount (excl GST)\nCOFFEE 3.00 ? 6.00\nTotal 6.00");
    expect(reverse.items[0]!.quantityExact).toBeNull();
    expect(reverse.items[0]!.evidence?.pricingBasis?.needsReview).toBe(true);
  });

  it("does not reinterpret unsupported receipt currency as observed SGD", () => {
    const r = parse("Currency USD\nSOAP 1 4.00\nTotal USD 4.00");
    expect(r.currency).toBe("SGD");
    expect(r.evidence?.currency).toMatchObject({ origin: "defaulted", needsReview: true });
    expect(r.uncertainFields).toContain("currency");
  });

  it("keeps a tender-derived suggestion distinct from missing printed-total evidence", () => {
    const r = parse("SOAP 1 4.00\nVisa 4.00");
    expect(r.receiptTotalCents).toBeNull();
    expect(r.suggestedTotalCents).toBe(400);
    expect(r.evidence?.total?.origin).toBe("unknown");
    expect(r.evidence?.suggestedTotal).toMatchObject({ origin: "inferred", needsReview: true });
  });

  it("does not equate split payments or cash/change with a printed total", () => {
    const split = parse("SOAP 1 4.00\nVisa 2.00\nPayNow 2.00");
    const cash = parse("SOAP 1 4.00\nCash 10.00\nChange 6.00");
    expect(split.suggestedTotalCents).toBeNull();
    expect(cash.suggestedTotalCents).toBeNull();
    expect(split.receiptTotalCents).toBeNull();
    expect(cash.receiptTotalCents).toBeNull();
    expect(receiptSummaryEvidence("Total 4.00\nVisa 2.00\nCash 2.00").ambiguous).toBe(true);
  });

  it("keeps conflicting printed totals flagged and exposes independent literal evidence", () => {
    const r = parse("SOAP 1 4.00\nT0TAL 4.00\nTOTAL DUE 5.00");
    expect(r.receiptTotalCents).toBe(400);
    expect(r.evidence?.total?.needsReview).toBe(true);
    expect(receiptSummaryEvidence("T0TAI 4.00\nTOTAL DUE 5.00").totals.map((total) => total.cents)).toEqual([400, 500]);
    const signed = parse("SOAP 1 4.00\nTotal 4.00-F\nVisa 4.00");
    expect(signed.receiptTotalCents).toBeNull();
    expect(signed.suggestedTotalCents).toBeNull();
    expect(signed.evidence?.total?.needsReview).toBe(true);
  });

  it("keeps an unpriced ambiguous table row inspectable without inventing a product amount", () => {
    const r = parse("Description Qty Amount\nPOSSIBLE PRODUCT\nSOAP 1 4.00\nTotal 4.00");
    expect(r.rows?.find((row) => row.text === "POSSIBLE PRODUCT")).toMatchObject({ role: "ambiguous", amountCents: null, needsReview: true });
  });

  it("does not join damaged numeric fragments to an unpriced financial note", () => {
    const r = parse("SOAP 1 4.00\nTEA 1 3.00\nTotal GST AMT DETAILS 9 £ 90 unreadable\n: 9 90\nTotal 7.00");
    expect(r.items.map((item) => item.description)).toEqual(["SOAP 1", "TEA 1"]);
    expect(r.items.every(item => item.quantityExact === null)).toBe(true);
    expect(r.rows?.find((row) => row.text.startsWith("Total GST AMT"))).toMatchObject({ role: "ambiguous", needsReview: true });
    const products = parse("TAX-FREE COLA 500ml\n1 4.00\nGST COLA 500ml\n1 3.00\nTotal 7.00");
    expect(products.items.map((item) => item.description)).toEqual(["TAX-FREE COLA 500ml", "GST COLA 500ml"]);
  });
});
