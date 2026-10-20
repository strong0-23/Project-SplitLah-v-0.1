import { describe, expect, it } from "vitest";
import { parseReceiptText, scoreParse, splitItemLabel } from "./parser";
import { computeTotals } from "./bill";

/**
 * Representative OCR output for a GST-inclusive Singapore restaurant receipt with a separate Qty
 * column, per-item "(GST*)" markers, a "Sales Amount" pre-tax subtotal and a "Total QTY" count line.
 * Synthetic text (no real receipt image or data); includes typical OCR misreads (#, +, Pj).
 */
const INCLUSIVE = `TABLE-4
Final Receipt
SAMPLE CURRY HOUSE Pj.
12 EXAMPLE ROAD
Tax Invoice
Bill Number 01234
Product Qty Total
SHARED FLATBREAD(GST#) 2 $6.00
SIMPLE FLATBREAD(GST*) 1 $3.00
SHARING BOWL(GST*) 1 $20.00
GRILLED TOFU B.LESS(GST+) 1 $10.00
FRUIT DRINK(GST*) 2 $5.00
Sales Amount $40.37
Total tax $3.63
Total QTY 7
Amount $44.00
PayNow $44.00`;

describe("parser: GST-inclusive receipt with Qty column", () => {
  const { receipt: r } = parseReceiptText(INCLUSIVE);

  it("skips TABLE-n / Final Receipt headings for merchant", () => {
    expect(r.merchant).toBe("SAMPLE CURRY HOUSE Pj");
  });
  it("keeps (GST*) items as items, reads trailing quantities, ignores B.LESS as discount", () => {
    expect(r.items.map((i) => [i.description, i.quantity, i.lineTotalCents])).toEqual([
      ["SHARED FLATBREAD", 2, 600],
      ["SIMPLE FLATBREAD", 1, 300],
      ["SHARING BOWL", 1, 2000],
      ["GRILLED TOFU B.LESS", 1, 1000],
      ["FRUIT DRINK", 2, 500],
    ]);
    expect(r.discountCents).toBe(0);
  });
  it("Sales Amount is net subtotal, Amount is payable total, Total QTY is not money", () => {
    expect(r.receiptTotalCents).toBe(4400);
    expect(r.printedNetSubtotalCents).toBe(4037);
    expect(r.printedSubtotalCents).toBeNull();
    expect(r.gstAmountCents).toBe(363);
    expect(r.serviceEnabled).toBe(false);
  });
  it("infers inclusive tax from arithmetic and reconciles with no GST added again", () => {
    expect(r.gstInclusive).toBe(true);
    const t = computeTotals(r);
    expect(t.ok && t.value).toMatchObject({ itemSubtotalCents: 4400, gstAddedCents: 0, gstIncludedCents: 363, totalCents: 4400, mismatchCents: 0 });
    expect(r.uncertainFields).not.toContain("charges");
  });
});

describe("parser: tax inclusivity is never inferred from item markers alone", () => {
  it("treats tax as added when items sum to subtotal and subtotal + tax = total", () => {
    const { receipt: r } = parseReceiptText(`Shop\nProduct Qty Total\nTEA(GST*) 1 $5.00\nSubtotal $5.00\nGST 9% $0.45\nTotal $5.45`);
    expect(r.gstInclusive).toBe(false);
    expect(computeTotals(r).ok && (computeTotals(r) as { value: { mismatchCents: number } }).value.mismatchCents).toBe(0);
  });
  it("flags ambiguity when the numbers fit neither interpretation (misread subtotal)", () => {
    const { receipt: r } = parseReceiptText(INCLUSIVE.replace("$40.37", "$31.11"));
    expect(r.gstInclusive).toBe(false);
    expect(r.uncertainFields).toContain("charges");
    expect(r.printedSubtotalCents).toBeNull();
    expect(r.printedNetSubtotalCents).toBe(3111);
    // Reconciliation gate stays: computed total (items + tax added) mismatches the printed total.
    const t = computeTotals(r);
    expect(t.ok && t.value.mismatchCents).not.toBe(0);
  });
});

describe("parser: items are not dropped silently", () => {
  it("keeps an item-section line whose price was lost, with null price and flagged", () => {
    const { receipt: r, warnings } = parseReceiptText(`Shop\nProduct Qty Total\nSHARED FLATBREAD(GST#) 2\nSIMPLE FLATBREAD(GST*) 1 $3.00\nAmount $9.00`);
    expect(r.items.map((i) => [i.description, i.quantity, i.lineTotalCents, i.flagged])).toEqual([["SHARED FLATBREAD", 2, null, true], ["SIMPLE FLATBREAD", 1, 300, false]]);
    expect(warnings.join(" ")).toMatch(/without a price/);
  });
  it("reads OCR 'I' in the qty column as 1 but flags it", () => {
    expect(splitItemLabel("LIME JUICE(GST#) I")).toMatchObject({ desc: "LIME JUICE", quantity: 1, qtyUncertain: true, taxMarked: true });
  });
});

describe("scoreParse", () => {
  it("prefers the internally consistent pass", () => {
    const good = parseReceiptText(INCLUSIVE).receipt;
    const bad = parseReceiptText(INCLUSIVE.replace("$40.37", "$31.11")).receipt;
    expect(scoreParse(good)).toBeGreaterThan(scoreParse(bad));
  });
});

