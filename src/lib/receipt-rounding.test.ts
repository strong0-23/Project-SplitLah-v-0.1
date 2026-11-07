import { describe, expect, it } from "vitest";
import { calculateBill, computeTotals } from "./bill";
import { emptyReceipt } from "./defaults";
import { MAX_CENTS } from "./money";
import { applyReceiptRounding, isReceiptRoundingLine } from "./receipt-rounding";
import type { ItemAssignment, Receipt, ReceiptItem } from "./types";

const item = (fields: Partial<ReceiptItem> = {}): ReceiptItem => ({
  id: "item", description: "Synthetic product", quantity: 1, lineTotalCents: 1000,
  evidence: { description: { origin: "observed", needsReview: false, reasons: [], sources: [{ kind: "text", lineIndices: [1], text: "1 x Synthetic product 10.00" }] } },
  ...fields,
});
const receipt = (fields: Partial<Receipt> = {}): Receipt => ({
  ...emptyReceipt(), items: [item()], serviceEnabled: false, gstEnabled: false, ...fields,
});
const detected = (rows: string, fields: Partial<Receipt> = {}) => applyReceiptRounding(receipt(fields), `SYNTHETIC SHOP\n1 x Synthetic product 10.00\n${rows}\nTotal 10.00`);
const participants = [{ id: "c", name: "C" }, { id: "b", name: "B" }, { id: "a", name: "A" }];
const even = (itemId = "item"): ItemAssignment => ({ itemId, mode: "even", participantIds: ["a", "b", "c"], amounts: {}, quantities: {} });

describe("independently labelled bill-rounding evidence", () => {
  it.each([2, -2, 5, -5])("applies explicit signed %i cents only in the final summary", (cents) => {
    const raw = `Cash rounding ${cents < 0 ? "-" : "+"}0.${String(Math.abs(cents)).padStart(2, "0")}`;
    const r = detected(raw);
    expect(r).toMatchObject({ roundingApplied: true, roundingAdjustmentCents: cents });
    expect(r.evidence?.rounding).toMatchObject({ origin: "observed", needsReview: false, sources: [{ lineIndices: [2], text: raw, observedValue: cents }] });
    expect(r.rows?.find((row) => row.role === "rounding")).toMatchObject({ text: raw, amountCents: cents, needsReview: false });
  });
  it.each([6, -6])("retains a larger signed amount (%i cents) without truncating or automatically applying it", (amount) => {
    const r = detected(`Bill rounding ${amount < 0 ? "-" : "+"}0.06`);
    expect(r).toMatchObject({ roundingAdjustmentCents: amount, roundingApplied: false });
    expect(r.rows?.[0]).toMatchObject({ role: "rounding", amountCents: amount, needsReview: true });
    expect(r.evidence?.rounding?.reasons).toContain("The rounding adjustment exceeds 5 cents; review it before applying it.");
  });
  it.each(["Rounding -0.02\nRounding -0.02", "Rounding -0.02\nRounding +0.02", "Rounding -0.02\nRounding -0.03"])("retains repeated or conflicting rows rather than summing or deduplicating: %s", (rows) => {
    const r = detected(rows);
    expect(r).toMatchObject({ roundingAdjustmentCents: null, roundingApplied: false });
    expect(r.rows?.filter((row) => row.role === "rounding")).toHaveLength(2);
    expect(r.evidence?.rounding?.needsReview).toBe(true);
  });
  it.each(["Cash rounding 0.02", "Cash rounding ?0.02", "Cash rounding unreadable", "Rounding"])("keeps missing sign or unreadable evidence unresolved: %s", (row) => {
    const r = detected(row);
    expect(r).toMatchObject({ roundingAdjustmentCents: null, roundingApplied: false });
    expect(r.rows?.some((line) => line.role === "rounding" && line.needsReview)).toBe(true);
    expect(r.evidence?.rounding?.needsReview).toBe(true);
  });
  it("accepts readable zero, trailing minus and negative parentheses without repairing digits", () => {
    expect(detected("Rounding 0.00")).toMatchObject({ roundingAdjustmentCents: 0, roundingApplied: true });
    expect(detected("Round off 0.02-")).toMatchObject({ roundingAdjustmentCents: -2, roundingApplied: true });
    expect(detected("Rounding adjustment (0.02)")).toMatchObject({ roundingAdjustmentCents: -2, roundingApplied: true });
    expect(detected("Cash rounding -O.02")).toMatchObject({ roundingAdjustmentCents: null, roundingApplied: false });
  });
  it("does not identify products merely containing rounding words", () => {
    expect(isReceiptRoundingLine("ROUND BISCUITS 3.00")).toBe(false);
    expect(isReceiptRoundingLine("Rounding biscuits 3.00")).toBe(false);
    expect(isReceiptRoundingLine("1 x Rounding biscuits 3.00")).toBe(false);
    expect(isReceiptRoundingLine("Cash rounding -0.02")).toBe(true);
  });
  it("requires supported final-summary placement, not only a recognised label", () => {
    const before = applyReceiptRounding(receipt({ items: [item({ evidence: { description: { origin: "observed", needsReview: false, reasons: [], sources: [{ kind: "text", lineIndices: [2] }] } } })] }), "SHOP\nCash rounding -0.02\n1 x Synthetic product 10.00\nTotal 9.98");
    expect(before.roundingApplied).toBe(false);
    const noSource = detected("Cash rounding -0.02", { items: [item({ evidence: undefined })] });
    expect(noSource.roundingApplied).toBe(false);
    const noSummary = applyReceiptRounding(receipt(), "SHOP\n1 x Synthetic product 10.00\nCash rounding -0.02");
    expect(noSummary.roundingApplied).toBe(false);
  });
  it("never manufactures rounding from the difference between amounts", () => {
    const r = receipt({ receiptTotalCents: 998 });
    const result = applyReceiptRounding(r, "SHOP\n1 x Synthetic product 10.00\nTotal 9.98");
    expect(result).toBe(r);
    expect(result.roundingAdjustmentCents).toBeUndefined();
    expect(computeTotals(result)).toMatchObject({ ok: true, value: { totalCents: 1000, mismatchCents: -2 } });
  });
  it("replaces a retained row classification without mutating its original input", () => {
    const old = receipt({ rows: [{ id: "row-2", role: "payment", text: "Rounding -0.02", amountCents: 2, needsReview: false, sources: [{ kind: "text", lineIndices: [2] }] }] });
    const r = applyReceiptRounding(old, "SHOP\n1 x Synthetic product 10.00\nRounding -0.02\nTotal 9.98");
    expect(r.rows).toHaveLength(1);
    expect(r.rows?.[0]).toMatchObject({ role: "rounding", amountCents: -2 });
    expect(old.rows?.[0]?.role).toBe("payment");
    expect(old.roundingApplied).toBeUndefined();
  });
});

describe("final payable and participant rounding", () => {
  it.each([5, -5])("applies %i cents after service and GST, retaining independent totals", (adjustment) => {
    const r = receipt({ serviceEnabled: true, gstEnabled: true, roundingAdjustmentCents: adjustment, roundingApplied: true, receiptTotalCents: 1199 + adjustment });
    const result = computeTotals(r);
    expect(result).toMatchObject({ ok: true, value: { serviceCents: 100, gstAddedCents: 99, unroundedTotalCents: 1199, roundingCents: adjustment, totalCents: 1199 + adjustment, mismatchCents: 0 } });
    expect(r.receiptTotalCents).toBe(1199 + adjustment);
    expect(calculateBill(r, participants, { item: even() })).toMatchObject({ ok: true });
  });
  it("does not change included GST or apply rounding to the printed payable twice", () => {
    const r = receipt({ gstEnabled: true, gstInclusive: true, roundingAdjustmentCents: -2, roundingApplied: true, receiptTotalCents: 998 });
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { gstIncludedCents: 83, gstAddedCents: 0, unroundedTotalCents: 1000, roundingCents: -2, totalCents: 998, mismatchCents: 0 } });
    expect(computeTotals({ ...r, receiptTotalCents: 996 })).toMatchObject({ ok: true, value: { totalCents: 998, mismatchCents: -2 } });
  });
  it("retains but does not calculate an unapplied adjustment; explicit user application may exceed 5 cents", () => {
    const r = receipt({ roundingAdjustmentCents: -10, roundingApplied: false });
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { unroundedTotalCents: 1000, roundingCents: 0, totalCents: 1000 } });
    expect(computeTotals({ ...r, roundingApplied: true })).toMatchObject({ ok: true, value: { roundingCents: -10, totalCents: 990 } });
  });
  it.each([2, -2, 5, -5])("allocates exactly %i signed cents deterministically regardless of input order", (rounding) => {
    const r = receipt({ items: [item({ lineTotalCents: 900 })], roundingAdjustmentCents: rounding, roundingApplied: true });
    const result = calculateBill(r, participants, { item: even() });
    if (!result.ok) throw new Error(result.errors.join(" "));
    const bills = Object.fromEntries(result.value.participants.map((p) => [p.participantId, p]));
    const sign = Math.sign(rounding);
    expect(bills["a"]?.roundingCents).toBe(sign * (Math.abs(rounding) === 5 ? 2 : 1));
    expect(bills["b"]?.roundingCents).toBe(sign * (Math.abs(rounding) === 5 ? 2 : 1));
    expect(bills["c"]?.roundingCents).toBe(sign * (Math.abs(rounding) === 5 ? 1 : 0));
    expect(result.value.participants.reduce((sum, p) => sum + (p.roundingCents ?? 0), 0)).toBe(rounding);
    expect(result.value.participants.reduce((sum, p) => sum + p.owedCents, 0)).toBe(900 + rounding);
  });
  it("uses pre-rounding payable magnitudes for refund allocation and equal weights for zero amounts", () => {
    const refund = receipt({ items: [item({ rowKind: "return", lineTotalCents: -900 })], roundingAdjustmentCents: -2, roundingApplied: true });
    expect(calculateBill(refund, participants, { item: even() })).toMatchObject({ ok: true, value: { participants: [{ participantId: "c", owedCents: -300 }, { participantId: "b", owedCents: -301 }, { participantId: "a", owedCents: -301 }] } });
    const zero = { ...refund, items: [item({ lineTotalCents: 0 })], roundingAdjustmentCents: 2 };
    expect(calculateBill(zero, participants, { item: even() })).toMatchObject({ ok: true, value: { participants: [{ participantId: "c", owedCents: 0 }, { participantId: "b", owedCents: 1 }, { participantId: "a", owedCents: 1 }] } });
  });
  it("rejects applying an unknown adjustment and overflow without changing tax or item values", () => {
    expect(computeTotals(receipt({ roundingApplied: true, roundingAdjustmentCents: null }))).toMatchObject({ ok: false, errors: [expect.stringContaining("explicit signed")] });
    expect(computeTotals(receipt({ roundingApplied: true, roundingAdjustmentCents: 1.5 }))).toMatchObject({ ok: false });
    expect(computeTotals(receipt({ items: [item({ lineTotalCents: MAX_CENTS })], roundingApplied: true, roundingAdjustmentCents: 1 }))).toMatchObject({ ok: false, errors: [expect.stringContaining("range")] });
  });
  it("preserves the previous output contract when no rounding field exists", () => {
    const result = computeTotals(receipt());
    expect(result).toEqual({ ok: true, value: { itemSubtotalCents: 1000, discountCents: 0, serviceCents: 0, gstAddedCents: 0, gstIncludedCents: 0, totalCents: 1000, mismatchCents: null } });
    const bills = calculateBill(receipt(), participants, { item: even() });
    expect(bills.ok && bills.value.participants.every((p) => p.roundingCents === undefined)).toBe(true);
  });
});
