import { describe, expect, it } from "vitest";
import { allocateLargestRemainder, parseMoney, parseRate, applyRate } from "./money";
import { allocateItem, calculateBill, computeTotals } from "./bill";
import { emptyReceipt, sampleSession } from "./defaults";
import { parseReceiptText } from "./parser";
import type { ItemAssignment, Participant, Receipt } from "./types";

const P: Participant[] = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
const asg = (itemId: string, mode: ItemAssignment["mode"], o: Partial<ItemAssignment> = {}): ItemAssignment => ({ itemId, mode, participantIds: [], quantities: {}, amounts: {}, ...o });
const receipt = (o: Partial<Receipt> = {}): Receipt => ({ ...emptyReceipt(), serviceEnabled: false, gstEnabled: false, ...o });
const sumOf = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

describe("money parsing", () => {
  it("parses decimal strings to cents without float error", () => {
    expect(parseMoney("0.29")).toBe(29);
    expect(parseMoney("$1,234.5")).toBe(123450);
    expect(parseMoney(".5")).toBe(50);
    expect(parseMoney("-1")).toBeNull();
    expect(parseMoney("1.234")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("99999999")).toBeNull();
  });
  it("parses rates into basis points", () => {
    expect(parseRate("9")).toBe(900);
    expect(parseRate("8.25%")).toBe(825);
    expect(parseRate("101")).toBeNull();
  });
  it("rounds half-up deterministically", () => {
    expect(applyRate(5, 1000)).toBe(1); // 0.5 -> 1
    expect(applyRate(4, 1000)).toBe(0);
  });
});

describe("largest remainder", () => {
  it("breaks ties by ascending id", () => {
    expect(allocateLargestRemainder(2, [{ id: "c", weight: 1 }, { id: "a", weight: 1 }, { id: "b", weight: 1 }])).toEqual({ a: 1, b: 1, c: 0 });
  });
  it("splits $10 three ways exactly", () => {
    const r = allocateLargestRemainder(1000, ["a", "b", "c"].map((id) => ({ id, weight: 1 })));
    expect(r).toEqual({ a: 334, b: 333, c: 333 });
  });
  it("rejects non-zero amount over zero weights", () => {
    expect(() => allocateLargestRemainder(5, [{ id: "a", weight: 0 }])).toThrow();
  });
});

describe("sample receipt", () => {
  it("totals 45.56 and reconciles exactly", () => {
    const s = sampleSession();
    const t = computeTotals(s.receipt);
    expect(t.ok && t.value).toMatchObject({ itemSubtotalCents: 3800, serviceCents: 380, gstAddedCents: 376, totalCents: 4556, mismatchCents: 0 });
    const res = calculateBill(s.receipt, s.participants, s.assignments);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const owed = res.value.participants.map((p) => p.owedCents);
    expect(owed.reduce((a, b) => a + b, 0)).toBe(4556);
    expect(res.value.participants.map((p) => p.itemSubtotalCents)).toEqual([800, 1400, 1400, 200]);
    expect(res.value.participants.reduce((a, p) => a + p.serviceCents, 0)).toBe(380);
    expect(res.value.participants.reduce((a, p) => a + p.gstAddedCents, 0)).toBe(376);
  });
});

describe("item allocation", () => {
  const item = { id: "x", description: "Beer", quantity: 3, lineTotalCents: 1000 };
  it("quantity split proportional and exact", () => {
    const r = allocateItem(item, asg("x", "quantity", { quantities: { a: 2, b: 1 } }), P);
    expect(r.state).toBe("complete");
    expect(r.shares).toEqual({ a: 667, b: 333 });
  });
  it("flags partial and over quantity", () => {
    expect(allocateItem(item, asg("x", "quantity", { quantities: { a: 2 } }), P).state).toBe("partial");
    expect(allocateItem(item, asg("x", "quantity", { quantities: { a: 2, b: 2 } }), P).state).toBe("over");
  });
  it("custom amounts must equal line total", () => {
    expect(allocateItem(item, asg("x", "custom", { amounts: { a: 400, b: 600 } }), P).state).toBe("complete");
    expect(allocateItem(item, asg("x", "custom", { amounts: { a: 400, b: 599 } }), P).state).toBe("partial");
    expect(allocateItem(item, asg("x", "custom", { amounts: { a: 400, b: 601 } }), P).state).toBe("over");
  });
  it("unassigned and invalid single", () => {
    expect(allocateItem(item, undefined, P).state).toBe("unassigned");
    expect(allocateItem(item, asg("x", "single", { participantIds: ["a", "b"] }), P).state).toBe("invalid");
    expect(allocateItem(item, asg("x", "even", { participantIds: ["gone"] }), P).state).toBe("unassigned");
  });
});

describe("bill calculation", () => {
  const items = [{ id: "i1", description: "Laksa", quantity: 1, lineTotalCents: 1000 }, { id: "i2", description: "Laksa", quantity: 1, lineTotalCents: 333 }];
  const all = { i1: asg("i1", "single", { participantIds: ["a"] }), i2: asg("i2", "single", { participantIds: ["b"] }) };

  it("handles duplicate item names as distinct items", () => {
    const res = calculateBill(receipt({ items }), P, all);
    expect(res.ok && res.value.participants.map((p) => p.owedCents)).toEqual([1000, 333, 0]);
  });
  it("distributes proportional percentage tax", () => {
    const res = calculateBill(receipt({ items, serviceEnabled: true, gstEnabled: true }), P, all);
    if (!res.ok) throw new Error(res.errors.join());
    const t = res.value.totals;
    expect(t.serviceCents).toBe(133);
    expect(t.gstAddedCents).toBe(applyRate(1333 + 133, 900));
    expect(res.value.participants.reduce((s, p) => s + p.owedCents, 0)).toBe(t.totalCents);
  });
  it("applies discount before service and GST", () => {
    const r = receipt({ items, discountCents: 333, serviceEnabled: true, gstEnabled: true });
    const t = computeTotals(r);
    expect(t.ok && t.value).toMatchObject({ serviceCents: 100, gstAddedCents: 99, totalCents: 1199 });
    const res = calculateBill(r, P, all);
    expect(res.ok && sumOf(Object.fromEntries(res.value.participants.map((p) => [p.participantId, p.discountCents])))).toBe(333);
  });
  it("rejects discount above subtotal", () => {
    expect(computeTotals(receipt({ items, discountCents: 2000 })).ok).toBe(false);
  });
  it("GST-inclusive is informational only", () => {
    const t = computeTotals(receipt({ items: [items[0]!], gstEnabled: true, gstInclusive: true }));
    expect(t.ok && t.value).toMatchObject({ totalCents: 1000, gstAddedCents: 0, gstIncludedCents: 83 });
  });
  it("receipt mode uses entered amounts, not percentages", () => {
    const t = computeTotals(receipt({ items, chargeMode: "receipt", serviceEnabled: true, serviceAmountCents: 150, gstEnabled: true, gstAmountCents: 50 }));
    expect(t.ok && t.value.totalCents).toBe(1333 + 200);
  });
  it("zero subtotal with charges is an error", () => {
    const r = receipt({ items: [{ id: "z", description: "Water", quantity: 1, lineTotalCents: 0 }], chargeMode: "receipt", serviceEnabled: true, serviceAmountCents: 100 });
    expect(computeTotals(r).ok).toBe(false);
  });
  it("blocks unassigned items", () => {
    const res = calculateBill(receipt({ items }), P, { i1: all.i1 });
    expect(res.ok).toBe(false);
  });
  it("blocks a one-cent receipt total discrepancy", () => {
    const res = calculateBill(receipt({ items, receiptTotalCents: 1334 }), P, all);
    expect(res.ok).toBe(false);
    expect(computeTotals(receipt({ items, receiptTotalCents: 1334 })).ok && (computeTotals(receipt({ items, receiptTotalCents: 1334 })) as { value: { mismatchCents: number } }).value.mismatchCents).toBe(1);
  });
  it("rejects missing line totals", () => {
    expect(computeTotals(receipt({ items: [{ id: "q", description: "?", quantity: 1, lineTotalCents: null }] })).ok).toBe(false);
  });
});

describe("OCR parser", () => {
  it("separates totals, tax and payment lines from items", () => {
    const text = `JOE'S DINER\n2 x Kopi 3.60\nNasi Lemak 5.50\nSubtotal 9.10\nSvc Chg 10% 0.91\nGST 9% 0.90\nTotal 10.91\nCash 20.00\nChange 9.09`;
    const { receipt: r } = parseReceiptText(text);
    expect(r.merchant).toBe("JOE'S DINER");
    expect(r.items.map((i) => [i.description, i.quantity, i.lineTotalCents])).toEqual([["Kopi", 2, 360], ["Nasi Lemak", 1, 550]]);
    expect(r).toMatchObject({ printedSubtotalCents: 910, receiptTotalCents: 1091, chargeMode: "receipt", serviceAmountCents: 91, gstAmountCents: 90 });
    const t = computeTotals(r);
    expect(t.ok && t.value.mismatchCents).toBe(0);
  });
});
