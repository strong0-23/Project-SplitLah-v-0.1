import { describe, expect, it } from "vitest";
import { allocateItem, calculateBill, computeTotals, validateItems } from "./bill";
import { emptyReceipt } from "./defaults";
import type { ItemAssignment, Receipt, ReceiptItem } from "./types";

const people = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
const item = (fields: Partial<ReceiptItem> = {}): ReceiptItem => ({ id: "a", description: "Item", quantity: 1, lineTotalCents: 1000, ...fields });
const receipt = (items: ReceiptItem[], fields: Partial<Receipt> = {}): Receipt => ({ ...emptyReceipt(), items, serviceEnabled: false, gstEnabled: false, ...fields });
const assignment = (mode: ItemAssignment["mode"], fields: Partial<ItemAssignment> = {}): ItemAssignment => ({ itemId: "a", mode, participantIds: ["a", "b"], amounts: {}, quantities: {}, ...fields });

describe("signed and fractional bill safety", () => {
  const credit = item({ rowKind: "return", quantityExact: { numerator: -1, denominator: 1 }, lineTotalCents: -101 });
  it("allows fractional quantities and identified returns without float financial arithmetic", () => {
    const fractional = item({ quantity: .75, quantityExact: { numerator: 3, denominator: 4 }, unitPriceCents: 200, lineTotalCents: 150 });
    expect(validateItems([fractional, credit])).toEqual([]);
    expect(computeTotals(receipt([fractional, credit], { receiptTotalCents: 49 }))).toMatchObject({ ok: true, value: { totalCents: 49, mismatchCents: 0 } });
    expect(computeTotals(receipt([credit], { receiptTotalCents: -101 }))).toMatchObject({ ok: true, value: { totalCents: -101, mismatchCents: 0 } });
  });
  it("requires deliberate classification for a negative line and rejects inconsistent signs", () => {
    expect(validateItems([item({ lineTotalCents: -100 })])).toHaveLength(1);
    expect(validateItems([item({ quantityExact: { numerator: -1, denominator: 1 }, rowKind: "return" })])).toHaveLength(1);
    expect(validateItems([item({ lineTotalCents: -100, rowKind: "adjustment" })])).toHaveLength(1);
    expect(validateItems([item({ lineTotalCents: -100, rowKind: "adjustment", pricingContext: { discounts: "none", tax: "compatible", adjustment: "explicit" } })])).toEqual([]);
  });
  it("splits a signed credit by absolute remainder and restores the sign", () => {
    expect(allocateItem(credit, assignment("even"), people)).toMatchObject({ state: "complete", shares: { a: -51, b: -50 }, remainingCents: 0 });
    expect(allocateItem(credit, assignment("single", { participantIds: ["b"] }), people)).toMatchObject({ state: "complete", shares: { b: -101 } });
    expect(calculateBill(receipt([credit]), people, { a: assignment("even") })).toMatchObject({ ok: true, value: { participants: [{ owedCents: -51 }, { owedCents: -50 }] } });
  });
  it("requires custom credit amounts to have the credit's sign", () => {
    expect(allocateItem(credit, assignment("custom", { amounts: { a: -51, b: -50 } }), people)).toMatchObject({ state: "complete", shares: { a: -51, b: -50 } });
    expect(allocateItem(credit, assignment("custom", { amounts: { a: -51, b: -49 } }), people).state).toBe("partial");
    expect(allocateItem(credit, assignment("custom", { amounts: { a: -52, b: -50 } }), people).state).toBe("over");
    expect(allocateItem(credit, assignment("custom", { amounts: { a: 51, b: -152 } }), people).state).toBe("invalid");
  });
  it("blocks fractional, unknown, inferred and signed quantities in unit splitting", () => {
    const inputs = [credit, item({ quantityExact: { numerator: 3, denominator: 2 } }), item({ quantityExact: null }), item({ evidence: { quantity: { origin: "inferred", needsReview: true, reasons: [], sources: [] } } })];
    for (const value of inputs) expect(allocateItem(value, assignment("quantity", { quantities: { a: 1 } }), people).state).toBe("invalid");
    expect(computeTotals(receipt([item({ quantityExact: null })]))).toMatchObject({ ok: true, value: { totalCents: 1000 } });
    expect(computeTotals(receipt([item({ evidence: { quantity: { origin: "unknown", needsReview: true, reasons: [], sources: [] } } })]))).toMatchObject({ ok: true, value: { totalCents: 1000 } });
  });
  it("allocates mixed bill charges using positive purchases, never negative weights", () => {
    const bought = item({ id: "b", lineTotalCents: 1000 });
    const returned = item({ id: "r", lineTotalCents: -200, rowKind: "return" });
    const result = calculateBill(receipt([bought, returned], { discountCents: 100, serviceEnabled: true }), people, { b: assignment("single", { itemId: "b", participantIds: ["a"] }), r: assignment("single", { itemId: "r", participantIds: ["b"] }) });
    expect(result).toMatchObject({ ok: true, value: { totals: { totalCents: 770 }, participants: [{ owedCents: 970, discountCents: 100, serviceCents: 70 }, { owedCents: -200, discountCents: 0, serviceCents: 0 }] } });
  });
  it("does not guess refund charge or tax treatment", () => {
    expect(computeTotals(receipt([credit], { gstEnabled: true }))).toMatchObject({ ok: false, errors: [expect.stringContaining("Refund-only")] });
    expect(computeTotals(receipt([credit], { serviceEnabled: true }))).toMatchObject({ ok: false, errors: [expect.stringContaining("Refund-only")] });
  });
  it("rejects existing contradictory unit/line relationships without changing their data", () => {
    const value = item({ quantity: 2, quantityExact: { numerator: 2, denominator: 1 }, unitPriceCents: 400, lineTotalCents: 1000 });
    expect(computeTotals(receipt([value]))).toMatchObject({ ok: false, errors: [expect.stringContaining("does not match")] });
    expect(value.lineTotalCents).toBe(1000);
  });
});
