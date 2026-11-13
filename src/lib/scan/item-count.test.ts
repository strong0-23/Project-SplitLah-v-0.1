/**
 * D15 (WO-002): quantities confirmed by the receipt's printed item count. Synthetic receipts with
 * invented shops and items only.
 */
import { describe, expect, it } from "vitest";
import { computeTotals } from "../bill";
import { quantitiesByItemCount } from "./items";
import { itemCountOf } from "./lexicon";
import { parseReceiptText, REASON } from "./parse";
import { reviewHints } from "./review";

const read = (t: string) => {
  const p = parseReceiptText(t);
  return {
    rows: p.receipt.items.map((i) => [i.description, i.quantity, i.lineTotalCents, i.flagged]),
    reasons: p.itemReasons,
    warnings: p.warnings,
    receipt: p.receipt,
  };
};
const D15_NOTE = /printed item count/;

describe("item count wording (lexicon)", () => {
  it.each([
    ["Total Qty 7", "7"],
    ["TOTAL QTY: 10", "10"],
    ["Total 5 items", "5"],
    ["Items: 3", "3"],
    ["No. of items 4", "4"],
    ["Item count 2", "2"],
    ["Jumlah barang 3", "3"],
    ["Anzahl Artikel: 3", "3"],
    ["Nombre d'articles 2", "2"],
    ["Aantal artikelen 6", "6"],
    ["Total Qty 2.5", "2.5"],
  ])("%s → %s", (label, n) => expect(itemCountOf(label)).toBe(n));

  it.each(["Qty 2", "Pax 3", "Number of Pax 1", "Item 7 Combo", "Total 5", "Items Sold Today"])(
    "%s is not an item count",
    (label) => expect(itemCountOf(label)).toBeNull(),
  );
});

describe("quantitiesByItemCount: all or nothing", () => {
  const row = (quantity: number, bare: number | null, ok = true, cents: number | null = 100) => ({
    quantity,
    lineTotalCents: cents,
    bare: bare === null ? null : { value: bare, ok },
  });
  it("takes every bare number when the sum is the count", () => {
    expect(quantitiesByItemCount([row(1, 2), row(1, null), row(2, null)], ["5"])).toEqual([
      2, 1, 2,
    ]);
  });
  it("changes nothing when the sum is off by one, either way", () => {
    expect(quantitiesByItemCount([row(1, 2), row(1, null)], ["4"])).toBeNull();
    expect(quantitiesByItemCount([row(1, 2), row(1, null)], ["2"])).toBeNull();
  });
  it("changes nothing without a count, with disagreeing or non-whole counts", () => {
    expect(quantitiesByItemCount([row(1, 2)], [])).toBeNull();
    expect(quantitiesByItemCount([row(1, 2)], ["2", "3"])).toBeNull();
    expect(quantitiesByItemCount([row(1, 2)], ["2.0"])).toBeNull();
    expect(quantitiesByItemCount([row(1, 2)], ["0"])).toBeNull();
  });
  it("changes nothing with a missing line total, a blocked row or no candidate", () => {
    expect(quantitiesByItemCount([row(1, 2), row(1, null, true, null)], ["3"])).toBeNull();
    expect(quantitiesByItemCount([row(1, 2, false)], ["2"])).toBeNull();
    expect(quantitiesByItemCount([row(1, null), row(1, null)], ["2"])).toBeNull();
  });
  it("changes nothing when a candidate row already has another quantity", () => {
    expect(quantitiesByItemCount([row(3, 2)], ["2"])).toBeNull();
  });
});

describe("D15 on whole receipts", () => {
  it("count after the items: trailing numbers become quantities, names lose them", () => {
    const r = read(`SAMPLE CAFE
Pancakes 2   16.00
Iced Lemon Tea 3   9.00
Muffin Set   5.50
Total Qty 6
TOTAL   30.50`);
    expect(r.rows).toEqual([
      ["Pancakes", 2, 1600, false],
      ["Iced Lemon Tea", 3, 900, false],
      ["Muffin Set", 1, 550, false],
    ]);
    expect(r.reasons).toEqual([null, null, null]);
    expect(r.warnings.some((w) => D15_NOTE.test(w))).toBe(true);
    const c = computeTotals(r.receipt);
    expect(c.ok && c.value.mismatchCents).toBe(0);
  });

  it("count before the items", () => {
    const r = read(`SAMPLE BAKERY
No. of items 3
Fruit Scone 2   7.00
Almond Danish   4.20
TOTAL   11.20`);
    expect(r.rows).toEqual([
      ["Fruit Scone", 2, 700, false],
      ["Almond Danish", 1, 420, false],
    ]);
  });

  it("a per-item tax marker between the name and the number", () => {
    const r = read(`SAMPLE BISTRO
Mushroom Soup(GST*)  2  $6.00
Fish Pie(GST*)  1  $8.50
Total Qty  3
Amount  $14.50`);
    expect(r.rows).toEqual([
      ["Mushroom Soup", 2, 600, false],
      ["Fish Pie", 1, 850, false],
    ]);
  });

  it("leading numbers, with the count on the total line", () => {
    const r = read(`SAMPLE NOODLE BAR
2 Wonton Noodles   12.00
1 Barley Water   2.20
Total 3 items   14.20`);
    expect(r.rows).toEqual([
      ["Wonton Noodles", 2, 1200, false],
      ["Barley Water", 1, 220, false],
    ]);
    expect(r.receipt.receiptTotalCents).toBe(1420);
  });

  it("mixed rows: explicit quantities and plain rows keep theirs", () => {
    const r = read(`SAMPLE KITCHEN
2 x Cappuccino   9.00
Fried Rice Special 2   24.00
Steamed Rice   1.00
Items: 5
TOTAL   34.00`);
    expect(r.rows).toEqual([
      ["Cappuccino", 2, 900, false],
      ["Fried Rice Special", 2, 2400, false],
      ["Steamed Rice", 1, 100, false],
    ]);
  });

  it("an explicit quantity wins: the number in its name stays", () => {
    const r = read(`SAMPLE PHARMACY
2 x Vitamin Tablets 12   18.00
Total Qty 2
TOTAL   18.00`);
    expect(r.rows).toEqual([["Vitamin Tablets 12", 2, 1800, false]]);
    expect(r.warnings.some((w) => D15_NOTE.test(w))).toBe(false);
  });

  it("D7's own unit × number test still decides first", () => {
    const r = read(`SAMPLE MART
Hand Soap 2   1.50   3.00
Dish Sponge   2.00
Total Qty 3
TOTAL   5.00`);
    expect(r.rows).toEqual([
      ["Hand Soap", 2, 300, false],
      ["Dish Sponge", 1, 200, false],
    ]);
    expect(r.warnings.some((w) => D15_NOTE.test(w))).toBe(false);
  });

  it("D7's unit × number test also drops a tax marker in front of the number", () => {
    const r = read(`SAMPLE BISTRO
Mushroom Soup(GST*)  2  3.00  6.00
Fish Pie   8.50
TOTAL   14.50`);
    expect(r.rows).toEqual([
      ["Mushroom Soup", 2, 600, false],
      ["Fish Pie", 1, 850, false],
    ]);
  });

  it("a confirmed row that is doubtful for another reason stays highlighted", () => {
    const r = read(`SAMPLE STALL
Tea 2   3.20
Kaya Bread Set   4.80
Total Qty 3
TOTAL   8.00`);
    expect(r.rows[0]).toEqual(["Tea", 2, 320, true]);
    expect(r.reasons[0]).toBe(REASON.check);
  });

  it("the review hints come back the same from the stored text", () => {
    const text = `SAMPLE CAFE
Pancakes 2   16.00
Muffin Set   5.50
Total Qty 3
TOTAL   21.50`;
    const r = read(text);
    expect(r.reasons).toEqual([null, null]);
    expect(reviewHints(r.receipt.rawOcrText).reasons.size).toBe(0);
    // Without the count line the same row keeps its D7 reason on the review screen.
    const without = reviewHints(text.replace("Total Qty 3\n", ""));
    expect([...without.reasons.values()]).toEqual([REASON.quantity]);
  });
});

describe("D15 negatives: nothing changes", () => {
  const D7 = [
    ["Pancakes 2", 1, 1600, true],
    ["Muffin Set", 1, 550, false],
  ];
  const base = (countLine: string) => `SAMPLE CAFE
Pancakes 2   16.00
Muffin Set   5.50
${countLine}
TOTAL   21.50`;

  it("no count printed: D7 keeps the number in the name, flagged", () => {
    const r = read(base("Thank you"));
    expect(r.rows).toEqual(D7);
    expect(r.reasons[0]).toBe(REASON.quantity);
  });

  it.each([
    ["off by one, over", "Total Qty 4"],
    ["off by one, under", "Total Qty 2"],
    ["not a whole number", "Total Qty 3.5"],
    ["people, not items", "Pax 3"],
    ["a per-row quantity, not a count", "Qty 3"],
  ])("%s", (_name, countLine) => {
    const r = read(base(countLine));
    expect(r.rows).toEqual(D7);
    expect(r.warnings.some((w) => D15_NOTE.test(w))).toBe(false);
  });

  it("two counts that disagree", () => {
    const r = read(`SAMPLE CAFE
Pancakes 2   16.00
Muffin Set   5.50
Items: 3
Total Qty 4
TOTAL   21.50`);
    expect(r.rows).toEqual(D7);
  });

  it("product names ending in a size or model number, with a count that doesn't match", () => {
    const r = read(`SAMPLE HARDWARE
Plant Pot 40   12.90
Cable Ties 100   3.50
Desk Lamp 7   15.00
Total Qty 3
TOTAL   31.40`);
    expect(r.rows.map((x) => [x[0], x[1]])).toEqual([
      ["Plant Pot 40", 1],
      ["Cable Ties 100", 1],
      ["Desk Lamp 7", 1],
    ]);
  });

  it("a count that matches only if some of the numbers are taken", () => {
    // Taking only "2" gives 2 + 1 = 3, the printed count; taking both gives 14. All or nothing.
    const r = read(`SAMPLE MART
Milk Powder Pack 12   9.90
Green Tea 2   3.00
Total Qty 3
TOTAL   12.90`);
    expect(r.rows.map((x) => [x[0], x[1]])).toEqual([
      ["Milk Powder Pack 12", 1],
      ["Green Tea 2", 1],
    ]);
  });

  it("a row with numbers at both ends", () => {
    const r = read(`SAMPLE MART
2 Hand Soap 3   4.00
Dish Sponge   2.00
Total Qty 3
TOTAL   6.00`);
    expect(r.rows.map((x) => [x[0], x[1]])).toEqual([
      ["2 Hand Soap 3", 1],
      ["Dish Sponge", 1],
    ]);
  });

  it("a row whose line total is missing", () => {
    const r = read(`SAMPLE MART
Green Tea 2   3.00
Rice Crackers 2 @ 1.50
Total Qty 4
TOTAL   6.00`);
    expect(r.rows[0]!.slice(0, 2)).toEqual(["Green Tea 2", 1]);
  });
});
