import { describe, expect, it } from "vitest";
import { calculateBill, computeTotals } from "./bill";
import { parseReceiptText, receiptSummaryEvidence } from "./parser";
import { receiptReviewReasons } from "./receipt-quality";

const money = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
const signed = (cents: number) => `${cents < 0 ? "-" : "+"}${money(Math.abs(cents))}`;

describe("parser to bill rounding integration", () => {
  it.each([2, -2, 5, -5])("keeps %i-cent final rounding out of products, charges, GST and tender", (rounding) => {
    const text = `SYNTHETIC SHOP\n1 x Synthetic meal 10.00\nSubtotal 10.00\nService charge 10% 1.00\nGST 9% 0.99\nCash rounding ${signed(rounding)}\nTotal ${money(1199 + rounding)}\nNETS ${money(1199 + rounding)}`;
    const { receipt: r } = parseReceiptText(text);
    expect(r.items.map((item) => [item.description, item.quantityExact, item.lineTotalCents]))
      .toEqual([["Synthetic meal", { numerator: 1, denominator: 1 }, 1000]]);
    expect(r).toMatchObject({ discountCents: 0, serviceAmountCents: 100, gstAmountCents: 99, gstInclusive: false, roundingAdjustmentCents: rounding, roundingApplied: true, receiptTotalCents: 1199 + rounding });
    expect(r.evidence?.rounding).toMatchObject({ origin: "observed", needsReview: false, sources: [{ text: `Cash rounding ${signed(rounding)}`, observedValue: rounding }] });
    expect(r.rows?.filter((row) => row.role === "rounding")).toHaveLength(1);
    expect(receiptSummaryEvidence(text).payments).toEqual([{ label: "NETS", cents: 1199 + rounding }]);
    expect(receiptReviewReasons(r).some((reason) => reason.path === "rounding")).toBe(false);
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { itemSubtotalCents: 1000, serviceCents: 100, gstAddedCents: 99, gstIncludedCents: 0, unroundedTotalCents: 1199, roundingCents: rounding, totalCents: 1199 + rounding, mismatchCents: 0 } });
    const item = r.items[0]!;
    const bill = calculateBill(r, [{ id: "b", name: "B" }, { id: "a", name: "A" }], { [item.id]: { itemId: item.id, mode: "even", participantIds: ["a", "b"], amounts: {}, quantities: {} } });
    expect(bill.ok).toBe(true);
    if (bill.ok) {
      expect(bill.value.participants.reduce((sum, p) => sum + (p.roundingCents ?? 0), 0)).toBe(rounding);
      expect(bill.value.participants.reduce((sum, p) => sum + p.owedCents, 0)).toBe(1199 + rounding);
    }
  });

  it("preserves explicit included GST and its original amount with negative rounding", () => {
    const { receipt: r } = parseReceiptText("SYNTHETIC SHOP\n1 x Synthetic meal 10.00\nPrices include GST\nSubtotal 9.17\nGST 9% 0.83\nBill rounding -0.02\nTotal 9.98");
    expect(r).toMatchObject({ gstInclusive: true, gstAmountCents: 83, printedNetSubtotalCents: 917, receiptTotalCents: 998, roundingApplied: true });
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { gstAddedCents: 0, gstIncludedCents: 83, unroundedTotalCents: 1000, roundingCents: -2, totalCents: 998, mismatchCents: 0 } });
  });

  it.each(["Rounding -0.02\nRounding -0.02", "Rounding -0.02\nRounding +0.02"])("retains repeated or conflicting summaries as unresolved without double counting: %s", (roundingRows) => {
    const { receipt: r, warnings } = parseReceiptText(`SYNTHETIC SHOP\n1 x Synthetic meal 10.00\nSubtotal 10.00\n${roundingRows}\nTotal 9.98`);
    expect(r.items).toHaveLength(1);
    expect(r).toMatchObject({ roundingAdjustmentCents: null, roundingApplied: false, receiptTotalCents: 998 });
    expect(r.rows?.filter((row) => row.role === "rounding")).toHaveLength(2);
    expect(r.rows?.filter((row) => row.role === "rounding").every((row) => row.needsReview)).toBe(true);
    expect(r.evidence?.rounding?.needsReview).toBe(true);
    expect(receiptReviewReasons(r).some((reason) => reason.path === "rounding")).toBe(true);
    expect(warnings.some((warning) => warning.includes("Multiple rounding rows"))).toBe(true);
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { roundingCents: 0, totalCents: 1000, mismatchCents: -2 } });
  });

  it.each(["Cash rounding +0.06", "Cash rounding 0.02", "Cash rounding ?0.02"])("keeps larger or sign-damaged rows inspectable and unapplied: %s", (row) => {
    const { receipt: r } = parseReceiptText(`SYNTHETIC SHOP\n1 x Synthetic meal 10.00\nSubtotal 10.00\n${row}\nTotal 10.00`);
    expect(r.items).toHaveLength(1);
    expect(r.roundingApplied).toBe(false);
    expect(r.rows?.find((line) => line.role === "rounding")).toMatchObject({ text: row, needsReview: true });
    expect(receiptReviewReasons(r).some((reason) => reason.path === "rounding")).toBe(true);
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { roundingCents: 0, totalCents: 1000, mismatchCents: 0 } });
  });
});
