/**
 * Batch 3 (structure + review): synthetic receipts, one per general pattern. Invented shops and
 * items only; each mirrors a layout pattern, never a specific receipt.
 */
import { describe, expect, it } from "vitest";
import { computeTotals } from "../bill";
import { parseReceiptText, REASON } from "./parse";
import { reviewHints, rowKey } from "./review";

const names = (t: string) => parseReceiptText(t).receipt.items.map((i) => i.description);
const mismatch = (t: string) => {
  const c = computeTotals(parseReceiptText(t).receipt);
  return c.ok ? c.value.mismatchCents : "invalid";
};

describe("total anchor: rows the printed total doesn't need are set aside, never deleted", () => {
  const T = `SAMPLE NOODLE HOUSE
Queue 58   3.00
Date 01/11/2026 12:30
Wonton Noodles   6.40
Barley Drink     1.70
Total            8.10
VISA             8.10`;

  it("hides a priced header row and keeps it recoverable", () => {
    const res = parseReceiptText(T);
    expect(names(T)).toEqual(["Wonton Noodles", "Barley Drink"]);
    expect(res.anchor).toBe("matched");
    expect(res.setAside).toEqual([
      { description: "Queue 58", quantity: 1, lineTotalCents: 300, reason: REASON.notNeeded },
    ]);
    expect(mismatch(T)).toBe(0);
  });

  it("marks the items for review, so a wrongly hidden line is never silent", () => {
    const res = parseReceiptText(T);
    expect(res.receipt.uncertainFields).toContain("items");
    expect(res.warnings[0]).toMatch(/1 line was set aside as probably not an item/);
  });

  it("gives the review screen the same hidden lines from the stored text", () => {
    const { receipt } = parseReceiptText(T);
    expect(reviewHints(receipt.rawOcrText).setAside.map((r) => r.description)).toEqual([
      "Queue 58",
    ]);
  });

  it("a real item hidden by coincidence (misread total) is never silent", () => {
    // True total 8.00; OCR read 6.00. The repaired (flagged) 2.00 item and the 1.00 header row are
    // the doubtful rows; only the header row fits, so a real item is hidden. The receipt is then
    // marked for item review and the screen says lines are hidden: never a plain "matches".
    const C = `SAMPLE TEA HOUSE
Queue 7   1.00
Date 01/11/2026 09:15
Oolong Pot     5.00
Almond Cookie  2.0O
Total   6.00`;
    const res = parseReceiptText(C);
    expect(res.setAside.map((r) => r.description)).toEqual(["Almond Cookie"]);
    expect(res.receipt.uncertainFields).toContain("items");
    expect(res.warnings[0]).toMatch(/set aside as probably not an item/);
  });

  it("never hides a real item when the total doesn't add up: the mismatch is shown instead", () => {
    const W = `SAMPLE BAKERY
Date 01/11/2026
Croissant   3.20
Baguette    4.80
Total       5.00`;
    const res = parseReceiptText(W);
    expect(names(W)).toEqual(["Croissant", "Baguette"]);
    expect(res.setAside).toEqual([]);
    expect(mismatch(W)).toBe(-300);
  });

  it("hides nothing when a payment disagrees with the total (the total may be incomplete)", () => {
    const P = `SAMPLE STORE
1 x HAND SOAP  4.00
Total  4.00
2 x GREEN TEA  3.00
PayNow  7.00`;
    const res = parseReceiptText(P);
    expect(res.setAside).toEqual([]);
    expect(names(P)).toEqual(["HAND SOAP", "GREEN TEA"]);
  });

  it("sets aside unpriced lines when the priced items already reach the total", () => {
    const U = `SAMPLE DESSERT BAR
Item            Amount
Grass Jelly     6.70
Brown Sugar Topping
Snow Ice        8.30
Total          15.00`;
    const res = parseReceiptText(U);
    expect(names(U)).toEqual(["Grass Jelly", "Snow Ice"]);
    expect(res.setAside.map((r) => [r.lineTotalCents, r.reason])).toEqual([
      [null, REASON.noPriceNotNeeded],
    ]);
  });
});

describe("header and footer guard", () => {
  it("keeps card, approval and reference lines out of the items, even with no total", () => {
    const T = `SAMPLE GIFT SHOP
Paper Notebook   5.90
Gel Pen Set      3.50
REFERENCE #: AB12CD34EF
APPROVAL #: 123456
CARDHOLDER COPY
MID 000000000001
TID: 00001111`;
    expect(names(T)).toEqual(["Paper Notebook", "Gel Pen Set"]);
  });

  it("flags a priced row printed among the shop details, with a reason", () => {
    const T = `SAMPLE HARDWARE
Counter 2   1.30
Tel 6000 0000
Hex Key Set   8.90
Cable Ties    2.10`;
    const res = parseReceiptText(T);
    const row = res.receipt.items.findIndex((i) => i.description === "Counter 2");
    expect(res.receipt.items[row]!.flagged).toBe(true);
    expect(res.itemReasons[row]).toBe(REASON.header);
    expect(res.itemReasons[1]).toBeNull();
  });
});

describe("finding the printed total", () => {
  it("reads 'Total Inc. GST' as the total and the GST amount after it as included", () => {
    const T = `SAMPLE MINI MART
Seaweed Snack 50G   3.70
Total Inc. GST   3.70
GST Amount   0.31
VISA   3.70`;
    const { receipt: r } = parseReceiptText(T);
    expect(r.receiptTotalCents).toBe(370);
    expect([r.gstEnabled, r.gstInclusive, r.gstAmountCents]).toEqual([true, true, 31]);
    expect(mismatch(T)).toBe(0);
  });

  it("takes the total a payment agrees with when two printed totals disagree", () => {
    const T = `SAMPLE CAFE
Latte    5.20
Muffin   4.10
TOTAL    9.30
TOTAL   10.30
NETS     9.30`;
    const res = parseReceiptText(T);
    expect(res.receipt.receiptTotalCents).toBe(930);
    expect(res.warnings.join(" ")).not.toMatch(/Printed totals disagree/);
  });

  it("uses cash tendered minus change as payment evidence", () => {
    const T = `SAMPLE KIOSK
Bottled Water   1.30
Sandwich        4.90
Total           6.20
Total          62.00
Cash           10.00
Change          3.80`;
    expect(parseReceiptText(T).receipt.receiptTotalCents).toBe(620);
  });

  it("never takes a payment, change, savings or points value as the total", () => {
    const T = `SAMPLE STATIONER
Glue Stick   2.40
Ruler        1.10
Total savings   0.50
Points earned   3.50
VISA   3.50
Change  0.00`;
    expect(parseReceiptText(T).receipt.receiptTotalCents).toBeNull();
  });

  it("adds totals printed per section when their sum is what was paid", () => {
    const T = `SAMPLE SERVICE STATION
Shop Sale
Chewing Gum   1.20
Total Inc. GST   1.20
Car Wash
2 x Wash Token @ 5.00   10.00
Total Inc. GST   10.00
Card Payment   11.20`;
    const res = parseReceiptText(T);
    expect(res.receipt.receiptTotalCents).toBe(1120);
    expect(res.receipt.uncertainFields).toContain("total");
    expect(names(T)).toEqual(["Chewing Gum", "Wash Token"]);
    expect(mismatch(T)).toBe(0);
  });

  it("reads 'Total 3 items' and 'Total Qty 3' lines with money as totals", () => {
    const A = `SAMPLE GROCER
Apples    4.20
Pears     6.30
Bananas   9.70
Total 3 items   20.20`;
    const B = A.replace("Total 3 items", "Total Qty 3");
    expect(parseReceiptText(A).receipt.receiptTotalCents).toBe(2020);
    expect(parseReceiptText(B).receipt.receiptTotalCents).toBe(2020);
    expect(names(A)).toEqual(["Apples", "Pears", "Bananas"]);
  });

  it("reads a total whose decimal point OCR read as a comma, flagged (D8)", () => {
    const T = `SAMPLE BISTRO
Soup of the Day   8.80
Garlic Bread      4.00
Total   $12,80`;
    const { receipt: r } = parseReceiptText(T);
    expect(r.receiptTotalCents).toBe(1280);
    expect(r.uncertainFields).toContain("total");
  });

  it("uses a last row equal to the items above it as a flagged total when no label was read", () => {
    const T = `SAMPLE COFFEE SHOP
Kopi          1.60
Kaya Toast    2.70
Tl   4.30`;
    const res = parseReceiptText(T);
    expect(names(T)).toEqual(["Kopi", "Kaya Toast"]);
    expect(res.receipt.receiptTotalCents).toBe(430);
    expect(res.receipt.uncertainFields).toEqual(expect.arrayContaining(["total", "items"]));
  });

  it("does not use that rule when charges are printed (a subtotal could be mistaken)", () => {
    const T = `SAMPLE COFFEE SHOP
Kopi          1.60
Kaya Toast    2.70
St   4.30
GST 9%   0.39`;
    expect(parseReceiptText(T).receipt.receiptTotalCents).toBeNull();
  });
});

describe("GST-inclusive tax tables", () => {
  it("reads the tax from a rate / net / tax / gross table and doesn't add it again", () => {
    const T = `SAMPLE HOMEWARE
Ceramic Mug    13.40
Tea Towel       8.40
Total          21.80
Rate  Net  Tax  Gross
A 9%  20.00  1.80  21.80
Mastercard     21.80`;
    const { receipt: r } = parseReceiptText(T);
    expect([r.gstEnabled, r.gstInclusive, r.gstAmountCents]).toEqual([true, true, 180]);
    expect(names(T)).toEqual(["Ceramic Mug", "Tea Towel"]);
    expect(mismatch(T)).toBe(0);
  });

  it("keeps the P5 check: a table tax that doesn't fit the rate is flagged", () => {
    const T = `SAMPLE HOMEWARE
Ceramic Mug    13.40
Tea Towel       8.40
Total          21.80
Rate  Net  Tax  Gross
A 9%  19.70  2.10  21.80`;
    const { receipt: r } = parseReceiptText(T);
    expect(r.gstInclusive).toBe(true);
    expect(r.uncertainFields).toContain("charges");
  });

  it("an unreadable table row still says prices include tax (GST off until the user adds it)", () => {
    const T = `SAMPLE BOOKSHOP
Bookmark Set    12.00
Total (SGD)     12.00
Tax  Net  Tax  Gross
Xs  9% ss  wq  12.0
VISA            12.00`;
    const { receipt: r } = parseReceiptText(T);
    expect([r.gstEnabled, r.gstInclusive]).toEqual([false, true]);
    expect(mismatch(T)).toBe(0);
  });

  it("a table on a receipt with GST added on top stays exclusive (the arithmetic decides)", () => {
    const T = `SAMPLE STUDIO
Item          Amount
Clay Class    50.00
Subtotal      50.00
GST 9%         4.50
Total         54.50
Net  Tax  Gross
50.00  4.50  54.50`;
    const { receipt: r } = parseReceiptText(T);
    expect([r.gstInclusive, r.gstAmountCents]).toEqual([false, 450]);
    expect(mismatch(T)).toBe(0);
  });
});

describe("item rows", () => {
  it("joins a name with the quantity × unit = total row under it", () => {
    const T = `SAMPLE TRATTORIA
Qty  Price  Total
Herb Risotto
2  $6.35  $12.70
Total  $12.70`;
    const { receipt: r } = parseReceiptText(T);
    expect(r.items.map((i) => [i.description, i.quantity, i.lineTotalCents, i.flagged])).toEqual([
      ["Herb Risotto", 2, 1270, false],
    ]);
  });

  it("gives each flagged row a short reason for the review screen", () => {
    const T = `SAMPLE DINER
Item           Amount
Fish Burger    1O.50
Onion Rings
Total          10.50`;
    const res = parseReceiptText(T);
    const hints = reviewHints(res.receipt.rawOcrText);
    const burger = res.receipt.items.find((i) => i.description === "Fish Burger")!;
    expect(hints.reasons.get(rowKey(burger))).toBe(REASON.repaired);
  });
});
