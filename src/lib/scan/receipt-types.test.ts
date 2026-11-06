/**
 * One synthetic OCR transcript per receipt style (no real receipts or personal data). Each must
 * parse into items that reconcile with the printed total using the same maths as the bill.
 */
import { describe, expect, it } from "vitest";
import { computeTotals } from "../bill";
import { parseReceiptText } from "./parse";

const rows = (t: string) =>
  parseReceiptText(t).receipt.items.map((i) => [i.description, i.quantity, i.lineTotalCents]);
const mismatch = (t: string) => {
  const c = computeTotals(parseReceiptText(t).receipt);
  return c.ok ? c.value.mismatchCents : "invalid";
};

describe("restaurant: service charge + GST added on top", () => {
  const T = `THE EXAMPLE BISTRO
Table 12   Pax 3
Item          Qty   Amount
Truffle Fries   1    12.00
Ribeye Steak    2    76.00
Iced Lemon Tea  3    13.50
Subtotal            101.50
Service Charge 10%   10.15
GST 9%               10.05
TOTAL               121.70
VISA                121.70`;
  it("reads items, rates and total", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(rows(T)).toEqual([
      ["Truffle Fries", 1, 1200],
      ["Ribeye Steak", 2, 7600],
      ["Iced Lemon Tea", 3, 1350],
    ]);
    expect(r.merchant).toBe("THE EXAMPLE BISTRO");
    expect([
      r.serviceAmountCents,
      r.serviceRateBp,
      r.gstAmountCents,
      r.gstRateBp,
      r.gstInclusive,
    ]).toEqual([1015, 1000, 1005, 900, false]);
    expect(mismatch(T)).toBe(0);
  });
});

describe("hawker / kopitiam: no charges", () => {
  const T = `KOPI CORNER
Kopi O          1.40
Kaya Toast Set  4.80
2 x Teh Peng    3.60
TOTAL           9.80
CASH           10.00
CHANGE          0.20`;
  it("has no charge warning when items equal the total", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(rows(T)).toEqual([
      ["Kopi O", 1, 140],
      ["Kaya Toast Set", 1, 480],
      ["Teh Peng", 2, 360],
    ]);
    expect(r.uncertainFields).not.toContain("charges");
    expect(mismatch(T)).toBe(0);
  });
});

describe("supermarket: name row + qty @ unit row, line discount, savings, rounding", () => {
  const T = `EXAMPLE MART
Blk 123 Sample Ave #01-01
Tel 6123 4567
MILO 1KG
2 @ 8.95                17.90
BANANA 0.512kg @ 3.98/kg 2.04
EGGS 10S                 3.20
  MEMBER DISC           -0.50
FRESH MILK 1L            3.35
SUBTOTAL                25.99
TOTAL SAVINGS            0.50
TOTAL                   25.99
ROUNDING                -0.04
TOTAL DUE               25.95
NETS                    25.95
Total Items 4`;
  it("merges the name row, keeps weighed goods at qty 1, applies the item discount", () => {
    expect(rows(T)).toEqual([
      ["MILO 1KG", 2, 1790],
      ["BANANA 0.512kg", 1, 204],
      ["EGGS 10S (MEMBER DISC -0.50)", 1, 270],
      ["FRESH MILK 1L", 1, 335],
    ]);
  });
  it("uses the unrounded total and ignores savings and item counts", () => {
    const { receipt: r, warnings } = parseReceiptText(T);
    expect(r.receiptTotalCents).toBe(2599);
    expect(r.discountCents).toBe(0);
    expect(warnings.join(" ")).toMatch(/rounded the payable amount by -0.04/);
    expect(mismatch(T)).toBe(0);
  });
});

describe("cafe: modifiers and add-ons stay with their item", () => {
  const T = `BEAN THERE CAFE
Latte (L)             6.50
 + Oat milk           0.80
 - Less sugar         0.00
Croissant             4.20
  Warm up
Subtotal             11.50
TOTAL                11.50`;
  it("folds priced and free modifiers into the item above", () => {
    expect(rows(T)).toEqual([
      ["Latte (L) (Oat milk 0.80) (Less sugar)", 1, 730],
      ["Croissant (Warm up)", 1, 420],
    ]);
    expect(mismatch(T)).toBe(0);
  });
});

describe("columns: description | qty | unit | total", () => {
  const T = `NOODLE HOUSE
Description      Qty   Price   Amount
Fried Rice        2    8.50    17.00
Wanton Soup       1    6.00     6.00
Lime Juice        3    2.50     7.50
Sub Total                      30.50
GST 9%                          2.75
Grand Total                    33.25`;
  it("confirms quantity from unit × qty", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(rows(T)).toEqual([
      ["Fried Rice", 2, 1700],
      ["Wanton Soup", 1, 600],
      ["Lime Juice", 3, 750],
    ]);
    expect(r.items.every((i) => !i.flagged)).toBe(true);
    expect(mismatch(T)).toBe(0);
  });
  it("infers quantity when only unit and total are printed", () => {
    expect(rows(`SHOP\nCola  1.80  5.40\nTOTAL 5.40`)).toEqual([["Cola", 3, 540]]);
  });
  it("flags a row whose columns disagree", () => {
    const { receipt: r } = parseReceiptText(`SHOP\nCola  2  1.80  5.40\nTOTAL 5.40`);
    expect(r.items[0]).toMatchObject({ lineTotalCents: 540, flagged: true });
  });
});

describe("bill-level discount and label on its own line", () => {
  const T = `PIZZA PLACE
Margherita        22.00
Pepperoni         26.00
SUBTOTAL          48.00
Discount 10%      -4.80
SERVICE CHARGE     4.32
GST                4.28
TOTAL
                  51.80`;
  it("applies the discount to the bill and reads a total printed on the next line", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(r.discountCents).toBe(480);
    expect(r.receiptTotalCents).toBe(5180);
    expect(mismatch(T)).toBe(0);
  });
});

describe("Malaysia: RM, SST, Jumlah, rounding adj", () => {
  const T = `RESTORAN CONTOH SDN BHD
Nasi Lemak Ayam     RM 12.90
Teh Tarik           RM 3.20
Roti Canai x2       RM 3.00
Subtotal            RM 19.10
Service Tax 6%      RM 1.15
Rounding Adj        -0.00
Jumlah              RM 20.25
Tunai               RM 50.00`;
  it("treats Service Tax as tax, reads Jumlah as total, notes the currency", () => {
    const { receipt: r, warnings, currency } = parseReceiptText(T);
    expect(rows(T)).toEqual([
      ["Nasi Lemak Ayam", 1, 1290],
      ["Teh Tarik", 1, 320],
      ["Roti Canai", 2, 300],
    ]);
    expect([r.serviceEnabled, r.gstAmountCents, r.gstRateBp]).toEqual([false, 115, 600]);
    expect(currency).toBe("MYR");
    expect(warnings.join(" ")).toMatch(/MYR/);
    expect(mismatch(T)).toBe(0);
  });
});

describe("Europe: decimal comma, VAT included", () => {
  const T = `CAFÉ EXEMPEL
Cappuccino        2 x 3,50     7,00 €
Croissant                      2,80 €
Mineralwasser                  3,20 €
Summe EUR                     13,00
inkl. MwSt 19%                 2,08
Bar                           20,00
Rückgeld                       7,00`;
  it("reads 3,50 as 3.50 and does not add VAT twice", () => {
    const { receipt: r, currency } = parseReceiptText(T);
    expect(rows(T)).toEqual([
      ["Cappuccino", 2, 700],
      ["Croissant", 1, 280],
      ["Mineralwasser", 1, 320],
    ]);
    expect(currency).toBe("EUR");
    expect(r.gstInclusive).toBe(true);
    expect(mismatch(T)).toBe(0);
  });
});

describe("thousands separators", () => {
  it("reads 1,234.50 and 1.234,50", () => {
    expect(rows(`HOTEL\nRoom 2 nights  1,234.50\nTOTAL  1,234.50`)).toEqual([
      ["Room 2 nights", 1, 123450],
    ]);
    expect(rows(`HOTEL\nZimmer  1.234,50\nZimmer  10,00\nSumme  1.244,50`)).toEqual([
      ["Zimmer", 1, 123450],
      ["Zimmer", 1, 1000],
    ]);
  });
});

describe("Indonesia: zero-decimal rupiah with dot thousands, PB1", () => {
  const T = `RUMAH MAKAN CONTOH
Nasi Goreng        2   Rp 50.000
Es Teh Manis       2   Rp 16.000
Sub Total              Rp 66.000
PB1 10%                Rp 6.600
Total                  Rp 72.600`;
  it("keeps whole rupiah and reconciles", () => {
    const { receipt: r, currency } = parseReceiptText(T);
    expect(currency).toBe("IDR");
    expect(rows(T)).toEqual([
      ["Nasi Goreng", 2, 5000000],
      ["Es Teh Manis", 2, 1600000],
    ]);
    expect(r.gstAmountCents).toBe(660000);
    expect(mismatch(T)).toBe(0);
  });
});

describe("Japan: yen, consumption tax included", () => {
  const T = `SAMPLE RAMEN
Shoyu Ramen        ¥980
Gyoza              ¥450
Beer               ¥600
Total            ¥2,030
(incl. tax 10%   ¥184)`;
  it("reads yen amounts and inclusive tax", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(rows(T)).toEqual([
      ["Shoyu Ramen", 1, 98000],
      ["Gyoza", 1, 45000],
      ["Beer", 1, 60000],
    ]);
    expect(r.gstInclusive).toBe(true);
    expect(mismatch(T)).toBe(0);
  });
});

describe("US: sales tax and tip lines", () => {
  const T = `EXAMPLE DINER
2 Pancakes        18.00
Coffee             3.50
Subtotal          21.50
Sales Tax 8.875%   1.91
Total             23.41
Suggested tip 18%  3.87
Suggested tip 20%  4.30`;
  it("ignores suggested tips", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(r.serviceEnabled).toBe(false);
    expect(r.gstRateBp).toBe(887);
    expect(rows(T)).toEqual([
      ["Pancakes", 2, 1800],
      ["Coffee", 1, 350],
    ]);
    expect(mismatch(T)).toBe(0);
  });
});

describe("OCR noise", () => {
  it("fixes letters inside numbers and ignores dates, times and phone numbers", () => {
    const T = `SHOP\nDate 06.11.26 19:47\nTel: 6123 4567\nNoodles  1O.5O\nTea  l.80\nTOTAL  12.30`;
    expect(rows(T)).toEqual([
      ["Noodles", 1, 1050],
      ["Tea", 1, 180],
    ]);
    expect(mismatch(T)).toBe(0);
  });
  it("does not read percentages as money", () => {
    const { receipt: r } = parseReceiptText(`SHOP\nTea  2.00\nGST 9.00%  0.18\nTotal 2.18`);
    expect(r.gstAmountCents).toBe(18);
  });
});
