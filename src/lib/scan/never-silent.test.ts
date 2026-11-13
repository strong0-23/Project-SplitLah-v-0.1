/**
 * WO-004: never silent on a newly readable receipt (D16, D17). Synthetic receipts only.
 *
 * D16: when nothing checks the money fields (no total was read, or the photo was only partly read),
 * every item row is flagged and items, total, charges and discount are marked uncertain.
 * D17: a printed total that disagrees with the items and charges read, by more than D4's cash
 * rounding under either tax reading, marks the total and the charges uncertain.
 */
import { describe, expect, it } from "vitest";
import {
  isConsistent,
  markUnchecked,
  parseReceiptText,
  REASON,
  scoreParse,
  scoreReading,
} from "./parse";
import { totalDisagreement } from "./reconcile";
import { reviewHints, rowKey } from "./review";

const MONEY = ["items", "total", "charges", "discount"];
const unsure = (text: string) => parseReceiptText(text).receipt.uncertainFields ?? [];

describe("D16: no total read → every row flagged, money fields uncertain", () => {
  const NO_TOTAL = `SAMPLE STATIONERS
Ruled Pad        3.20
Glue Stick       1.80`;

  it("flags every item row with a reason and marks the money fields", () => {
    const res = parseReceiptText(NO_TOTAL);
    expect(res.receipt.receiptTotalCents).toBeNull();
    expect(res.receipt.items.map((i) => i.flagged)).toEqual([true, true]);
    expect(res.itemReasons).toEqual([REASON.noTotal, REASON.noTotal]);
    expect(res.receipt.uncertainFields).toEqual(expect.arrayContaining(MONEY));
  });

  it("changes no amount, quantity or name", () => {
    const res = parseReceiptText(NO_TOTAL);
    expect(res.receipt.items.map((i) => [i.description, i.quantity, i.lineTotalCents])).toEqual([
      ["Ruled Pad", 1, 320],
      ["Glue Stick", 1, 180],
    ]);
  });

  it("keeps the reason of a row already flagged for something else", () => {
    const res = parseReceiptText(`SAMPLE STATIONERS\nRuled Pad   3.2O\nGlue Stick  1.80`);
    expect(res.itemReasons).toEqual([REASON.repaired, REASON.noTotal]);
  });

  it("flags payment and total lines whose labels were too damaged to read (rows after them)", () => {
    // Damaged labels: the total, the item count and the card line are not recognised, so they
    // become item rows. With no total read, none of them may pass silently.
    const res = parseReceiptText(`SAMPLE STATIONERS
Ruled Pad        3.20
Glue Stick       1.80
Tota1 Qtv: 2 [ota1 S$: 5.00
Vlza/MK:         5.00
Closing Sum:     5.00`);
    expect(res.receipt.receiptTotalCents).toBeNull();
    expect(res.receipt.items.length).toBeGreaterThan(2);
    expect(res.receipt.items.every((i) => i.flagged)).toBe(true);
  });

  it("the review hints give the same reasons from the stored text", () => {
    const res = parseReceiptText(NO_TOTAL);
    const hints = reviewHints(res.receipt.rawOcrText);
    expect(hints.noTotalRead).toBe(true);
    for (const it of res.receipt.items) expect(hints.reasons.get(rowKey(it))).toBe(REASON.noTotal);
  });

  it("negative: a reading whose total matches its items gets no new flags or marks", () => {
    const res = parseReceiptText(`${NO_TOTAL}\nTotal            5.00`);
    expect(res.receipt.items.some((i) => i.flagged)).toBe(false);
    expect(res.itemReasons).toEqual([null, null]);
    expect(res.receipt.uncertainFields ?? []).not.toContain("total");
    expect(res.receipt.uncertainFields ?? []).not.toContain("discount");
  });
});

describe("D16: markUnchecked (a partly read photo)", () => {
  const TEXT = `SAMPLE DINER
Soup Bowl        4.50
Garlic Br3ad     2.0O
Total            6.50`;

  it("flags every row, keeps existing reasons, marks the money fields; pure", () => {
    const before = parseReceiptText(TEXT);
    const snapshot = JSON.stringify(before);
    const after = markUnchecked(before, REASON.partlyRead);
    expect(JSON.stringify(before)).toBe(snapshot); // the input is not changed
    expect(after.receipt.items.every((i) => i.flagged)).toBe(true);
    expect(after.itemReasons).toEqual([REASON.partlyRead, REASON.repaired]);
    expect(after.receipt.uncertainFields).toEqual(expect.arrayContaining(MONEY));
    // Nothing read is changed.
    expect(after.receipt.items.map((i) => [i.description, i.quantity, i.lineTotalCents])).toEqual(
      before.receipt.items.map((i) => [i.description, i.quantity, i.lineTotalCents]),
    );
    expect(after.receipt.receiptTotalCents).toBe(before.receipt.receiptTotalCents);
  });
});

describe("D17: a total that disagrees with the items and charges is marked uncertain", () => {
  it("marks the total and charges when complete items differ by more than 5 cents", () => {
    const u = unsure(`SAMPLE SHOP\nCanvas Tote   12.00\nKey Ring       3.00\nTotal         14.20`);
    expect(u).toEqual(expect.arrayContaining(["total", "charges"]));
  });

  it("negative: a difference within D4's cash rounding is not marked by D17", () => {
    const u = unsure(`SAMPLE SHOP\nCanvas Tote   12.00\nKey Ring       3.02\nTotal         15.00`);
    expect(u).not.toContain("total");
  });

  it("negative: tax added on top, or already in the prices, both agree", () => {
    const added = `SAMPLE SHOP\nCanvas Tote   12.00\nKey Ring       3.00\nGST 9%         1.35\nTotal         16.35`;
    const included = `SAMPLE SHOP\nCanvas Tote   12.00\nKey Ring       3.00\nTotal         15.00\nGST 9% incl.   1.24`;
    expect(unsure(added)).not.toContain("total");
    expect(unsure(included)).not.toContain("total");
  });

  it("with prices missing: marks the total when the prices read already exceed it, with a warning", () => {
    const res = parseReceiptText(`SAMPLE SHOP
Canvas Tote   12.00
Key Ring       3.00
Gift Wrap
Total         11.40`);
    expect(res.receipt.items.some((i) => i.lineTotalCents === null)).toBe(true);
    expect(res.receipt.uncertainFields).toEqual(expect.arrayContaining(["total", "charges"]));
    expect(
      res.warnings.some((w) => /already come to 15\.00, more than the printed total/.test(w)),
    ).toBe(true);
  });

  it("negative: with prices missing and the prices read below the total, nothing is guessed", () => {
    const res = parseReceiptText(`SAMPLE SHOP
Canvas Tote   12.00
Gift Wrap
Total         15.00`);
    expect(res.receipt.items.some((i) => i.lineTotalCents === null)).toBe(true);
    expect(totalDisagreement(res.receipt)).toBeNull();
    expect(res.warnings.some((w) => /more than the printed total/.test(w))).toBe(false);
  });

  it("changes no amount and no total", () => {
    const res = parseReceiptText(
      `SAMPLE SHOP\nCanvas Tote   12.00\nKey Ring       3.00\nTotal         14.20`,
    );
    expect(res.receipt.receiptTotalCents).toBe(1420);
    expect(res.receipt.items.map((i) => i.lineTotalCents)).toEqual([1200, 300]);
  });
});

describe("the review marks leave the second-pass choice (D14) unchanged", () => {
  it("scoreReading scores the reading before the marks", () => {
    const lines = [`SAMPLE STATIONERS`, `Ruled Pad        3.20`, `Glue Stick       1.80`];
    const marked = parseReceiptText(lines.join("\n")).receipt;
    const s = scoreReading(lines);
    // The marked receipt has every row flagged; the scorer does not see those flags.
    expect(s.score).toBeGreaterThan(scoreParse(marked));
    expect(s.good).toBe(isConsistent(marked)); // no total: never "good" either way
  });

  it("a consistent reading scores the same with or without the marks step", () => {
    const lines = [`SAMPLE STATIONERS`, `Ruled Pad  3.20`, `Glue Stick 1.80`, `Total      5.00`];
    const r = parseReceiptText(lines.join("\n")).receipt;
    expect(scoreReading(lines)).toEqual({ score: scoreParse(r), good: isConsistent(r) });
  });
});
