/**
 * One synthetic OCR transcript per receipt style (no real receipts or personal data). Each must
 * parse into items that reconcile with the printed total using the same maths as the bill.
 */
import { describe, expect, it } from "vitest";
import { computeTotals } from "../bill";
import { FOLDED_FEES_NOTE, hasFoldedFees, parseReceiptText } from "./parse";

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
    // Batch 1b (owner decision, parser-v2 rule): no Qty heading, so the bare "2" stays in the
    // name and the row is flagged for the user to check, instead of being read as quantity 2.
    expect(rows(T)).toEqual([
      ["Nasi Goreng 2", 1, 5000000],
      ["Es Teh Manis 2", 1, 1600000],
    ]);
    expect(r.items.every((i) => i.flagged)).toBe(true);
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
    // Batch 1b (owner decision, parser-v2 rule): an unheaded leading "2" stays in the name, flagged.
    expect(rows(T)).toEqual([
      ["2 Pancakes", 1, 1800],
      ["Coffee", 1, 350],
    ]);
    expect(r.items.map((i) => i.flagged)).toEqual([true, false]);
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

describe("long receipt: descriptions wrapped over 3 lines", () => {
  const T = `SAMPLE KITCHEN
Item                        Qty   Amount
Chicken Rice                 1     5.50
Signature Seafood Platter with
Grilled Prawns, Squid and
Garlic Butter Sauce          1    38.00
Iced Water                   2     1.00
Nasi Lemak Special with      1    12.50
Fried Chicken, Egg and
Sambal Prawns
Kaya Toast                   2     4.40
Soft Boiled Eggs             2     3.00
Teh Tarik                    3     6.30
Fishball Noodles             1     6.80
Wanton Mee                   1     7.20
Barley Drink                 2     3.60
Subtotal                          88.30
GST 9%                             7.95
Total                             96.25`;
  it("joins each wrapped description into one item and reconciles", () => {
    expect(rows(T)).toEqual([
      ["Chicken Rice", 1, 550],
      ["Signature Seafood Platter with Grilled Prawns, Squid and Garlic Butter Sauce", 1, 3800],
      ["Iced Water", 2, 100],
      ["Nasi Lemak Special with Fried Chicken, Egg and Sambal Prawns", 1, 1250],
      ["Kaya Toast", 2, 440],
      ["Soft Boiled Eggs", 2, 300],
      ["Teh Tarik", 3, 630],
      ["Fishball Noodles", 1, 680],
      ["Wanton Mee", 1, 720],
      ["Barley Drink", 2, 360],
    ]);
    expect(mismatch(T)).toBe(0);
  });
});

describe("two subtotals: the second comes after the discount", () => {
  const T = `SAMPLE GRILL
Burger                 18.00
Fries                   6.00
Cola                    4.00
Subtotal               28.00
Discount 10%           -2.80
Subtotal               25.20
Service Charge 10%      2.52
GST 9%                  2.49
Total                  30.21`;
  it("keeps the first subtotal, applies the discount once and reconciles", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(r.printedSubtotalCents).toBe(2800);
    expect(r.discountCents).toBe(280);
    expect([r.serviceAmountCents, r.gstAmountCents, r.receiptTotalCents]).toEqual([252, 249, 3021]);
    expect(r.uncertainFields).not.toContain("charges");
    expect(mismatch(T)).toBe(0);
  });
});

describe("no item header: address lines with price-like numbers", () => {
  const T = `CORNER BAKERY
Unit 3.12, Sample Mall
Blk 88 Sample Road #02-15
Singapore 123456
Sourdough Loaf      7.50
Cinnamon Roll       3.80
TOTAL              11.30`;
  it("never reads the address as an item", () => {
    const { receipt: r, warnings } = parseReceiptText(T);
    expect(r.merchant).toBe("CORNER BAKERY");
    expect(rows(T)).toEqual([
      ["Sourdough Loaf", 1, 750],
      ["Cinnamon Roll", 1, 380],
    ]);
    expect(warnings.join(" ")).not.toMatch(/Lines not used/);
    expect(mismatch(T)).toBe(0);
  });
});

describe("delivery app printout: delivery and platform fees (D6)", () => {
  const T = `FOODDASH
Order Summary
Order # D-48213
1x Chicken Rice          5.50
2x Iced Milo             5.00
1x Fried Wings           8.00
Subtotal                18.50
Delivery Fee             3.99
Delivery Discount       -1.00
Platform Fee             0.40
Total                   21.89
Paid by Card            21.89`;
  it("counts the fees as a service charge, not as items", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(rows(T)).toEqual([
      ["Chicken Rice", 1, 550],
      ["Iced Milo", 2, 500],
      ["Fried Wings", 1, 800],
    ]);
    expect([r.serviceEnabled, r.serviceAmountCents]).toEqual([true, 339]);
    expect(mismatch(T)).toBe(0);
  });

  it("records which fee lines were folded into the service amount (1a)", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(r.ocrWarnings?.[0]).toBe(`${FOLDED_FEES_NOTE} Delivery Fee 3.99, Platform Fee 0.40.`);
    expect(hasFoldedFees(r.ocrWarnings)).toBe(true);
    expect(hasFoldedFees(parseReceiptText(T2).receipt.ocrWarnings)).toBe(true);
  });

  it("does not record fees when the service amount is only a service charge", () => {
    const plain = `BISTRO\nSteak  30.00\nSubtotal  30.00\nService Charge 10%  3.00\nTotal  33.00`;
    expect(hasFoldedFees(parseReceiptText(plain).receipt.ocrWarnings)).toBe(false);
    expect(hasFoldedFees(undefined)).toBe(false);
  });

  const T2 = `SAMPLE THAI KITCHEN
Pad Thai             2    24.00
Green Curry          1    15.00
Subtotal                  39.00
Service Charge 10%         3.90
Delivery Charge            5.00
Packaging Fee              0.60
GST 9%                     4.37
Total                     52.87`;
  it("adds a service charge and a delivery fee together and reconciles", () => {
    const { receipt: r } = parseReceiptText(T2);
    // Batch 1b (owner decision): no Qty heading, so the bare numbers stay in the names, flagged.
    expect(r.items.map((i) => i.description)).toEqual(["Pad Thai 2", "Green Curry 1"]);
    expect([r.serviceAmountCents, r.gstAmountCents, r.gstInclusive]).toEqual([950, 437, false]);
    expect(r.uncertainFields).not.toContain("charges");
    expect(mismatch(T2)).toBe(0);
  });

  it("does not read a product named after a fee word as a charge", () => {
    expect(rows(`SHOP\nDelivery Box Set  12.00\nTOTAL 12.00`)).toEqual([
      ["Delivery Box Set", 1, 1200],
    ]);
  });
});

describe("a Total printed in the footer after the payment lines", () => {
  const T = `SAMPLE CAFE
Flat White           5.50
Muffin               4.00
Subtotal             9.50
GST 9%               0.86
Total               10.36
CASH                20.00
CHANGE               9.64
** Customer Copy **
TOTAL               20.00`;
  it("uses the last total before payment", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(r.receiptTotalCents).toBe(1036);
    expect(mismatch(T)).toBe(0);
  });
});

describe("OCR text with | column separators", () => {
  const T = `| SAMPLE DINER |
| Item          | Qty | Amount |
| Chicken Chop  |  1  |  14.50 |
| Iced Tea      |  2  |   5.00 |
| Subtotal      |     |  19.50 |
| GST 9%        |     |   1.76 |
| Total         |     |  21.26 |`;
  it("treats spaced pipes as column gaps, not digits", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(r.merchant).toBe("SAMPLE DINER");
    expect(rows(T)).toEqual([
      ["Chicken Chop", 1, 1450],
      ["Iced Tea", 2, 500],
    ]);
    expect(r.gstAmountCents).toBe(176);
    expect(mismatch(T)).toBe(0);
  });
  it("still reads a pipe touching a digit as OCR noise for 1", () => {
    expect(rows(`SHOP\nNoodles  |2.50\nTOTAL 12.50`)).toEqual([["Noodles", 1, 1250]]);
  });
});

/*
 * Batch 1b: one synthetic fixture per real-receipt failure pattern P1–P5 (owner PC test,
 * 7 Nov 2026). Written from the pattern descriptions only, with invented names and amounts.
 */
describe("P1: summary/footer lines and a price-lost item are never notes on another item", () => {
  const T = `GREEN LEAF GROCER
Description              Qty   Amount
SPARKLING WATER           2     3.60
WHOLEMEAL LOAF
SEA SALT CRISPS           1     2.95
Subtotal                        9.75
Total (SGD) incl. GST
9.75
Transaction No 004127
Transaction Date 06/11/2026 19:42`;
  it("keeps item names clean and the price-lost item as its own flagged row", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(rows(T)).toEqual([
      ["SPARKLING WATER", 2, 360],
      ["WHOLEMEAL LOAF", 1, null],
      ["SEA SALT CRISPS", 1, 295],
    ]);
    expect(r.items[1]!.flagged).toBe(true);
    expect(r.receiptTotalCents).toBe(975);
  });
  it("reconciles once the user enters the missing price", () => {
    const { receipt: r } = parseReceiptText(T);
    r.items[1]!.lineTotalCents = 320;
    const c = computeTotals(r);
    expect(c.ok && c.value.mismatchCents).toBe(0);
  });
  it("still attaches a real add-on, and nothing else, to the item above", () => {
    expect(rows(`CAFE\nItem Qty Amount\nLATTE 1 6.00\n+ Oat milk\nThank you\nTotal 6.00`)).toEqual([
      ["LATTE (Oat milk)", 1, 600],
    ]);
  });
});

describe("P2: bare numbers and OCR tokens are not quantities", () => {
  const T = `FRESH MART
BABY SPINACH PW 4         2.50
GREEK YOGHURT % 8         4.20
TOTAL                     6.70`;
  it("keeps quantity 1 and flags rows whose trailing number has no Qty column", () => {
    const { receipt: r } = parseReceiptText(T);
    expect(rows(T)).toEqual([
      ["BABY SPINACH PW 4", 1, 250],
      ["GREEK YOGHURT % 8", 1, 420],
    ]);
    expect(r.items.every((i) => i.flagged)).toBe(true);
    expect(mismatch(T)).toBe(0);
  });
  const C = `EXAMPLE CINEMA
Description        Qty   Amount
NIGHT SHOW (Adult)
2                       24.00
Grand Total (INCL GST)  24.00
Credit                  24.00`;
  it("reads a ticket's quantity from its own quantity-and-amount row", () => {
    expect(rows(C)).toEqual([["NIGHT SHOW (Adult)", 2, 2400]]);
    expect(mismatch(C)).toBe(0);
  });
});

describe("P3: an item discount repeated in the summary is counted once", () => {
  const T = `SAMPLE PHARMACY
VITAMIN C 1000MG          18.90
  MEMBER DISC             -2.00
HAND CREAM                 7.50
SUBTOTAL                  24.40
DISCOUNT                  -2.00
TOTAL SAVINGS              2.00
TOTAL                     24.40
NETS                      24.40`;
  it("keeps the item-level discount and does not deduct the repeat again", () => {
    const { receipt: r, warnings } = parseReceiptText(T);
    expect(rows(T)).toEqual([
      ["VITAMIN C 1000MG (MEMBER DISC -2.00)", 1, 1690],
      ["HAND CREAM", 1, 750],
    ]);
    expect(r.discountCents).toBe(0);
    expect(warnings.join(" ")).toMatch(/repeats the item discounts above/);
    expect(r.uncertainFields).not.toContain("discount");
    expect(mismatch(T)).toBe(0);
  });
});

describe("P4: an OCR-damaged total label and a total with its decimal point lost", () => {
  const T = `NOODLE BAR
Item               Qty   Amount
DRY MEE POK         2    11.00
FISHBALL SOUP       1     6.50
ICED LEMON TEA      2     5.00
Subtotal                 22.50
GST 9%                    2.03
T0TAL                    2453`;
  it("never reads the total row as an item and accepts 24.53 only because it reconciles", () => {
    const { receipt: r, warnings } = parseReceiptText(T);
    expect(r.items.map((i) => i.description)).toEqual([
      "DRY MEE POK",
      "FISHBALL SOUP",
      "ICED LEMON TEA",
    ]);
    expect(r.receiptTotalCents).toBe(2453);
    expect(r.uncertainFields).toContain("total");
    expect(warnings.join(" ")).toMatch(/no decimal point/);
    expect(mismatch(T)).toBe(0);
  });
  it("keeps the total as not found when the damaged number doesn't reconcile", () => {
    const { receipt: r } = parseReceiptText(T.replace("2453", "2455"));
    expect(r.receiptTotalCents).toBeNull();
  });
  it("reads OCR-confused total labels (TOTA1, T0TAL) as the total", () => {
    const { receipt: r } = parseReceiptText(`SHOP\nSOAP 4.00\nTOTA1 4.00`);
    expect([r.items.length, r.receiptTotalCents]).toEqual([1, 400]);
  });
});

describe("P5: a GST or service amount that doesn't match its rate is flagged, never changed", () => {
  const T = `SAMPLE CAFE
Item               Qty   Amount
FLAT WHITE          2    11.00
AVOCADO TOAST       1    16.50
GRANOLA BOWL        2    25.80
CHAI LATTE          3    15.10
Subtotal                 68.40
GST 9%                    6.18
Total                    74.58`;
  it("flags GST 6.18 where 9% of 68.40 is 6.16, and shows the expected value", () => {
    const { receipt: r, warnings } = parseReceiptText(T);
    expect(r.gstAmountCents).toBe(618);
    expect(r.uncertainFields).toContain("charges");
    expect(warnings.join(" ")).toMatch(/GST is printed as 6\.18, but 9% of 68\.40 is 6\.16/);
    expect(mismatch(T)).toBe(0); // it still reconciles to the printed total
  });
  it("does not flag a GST amount that matches its rate", () => {
    const { receipt: r } = parseReceiptText(T.replace("6.18", "6.16").replace("74.58", "74.56"));
    expect(r.uncertainFields).not.toContain("charges");
  });
  it("flags a service charge that doesn't match its printed rate", () => {
    const S = T.replace(
      "GST 9%                    6.18\nTotal                    74.58",
      "Service Charge 10%        6.85\nTotal                    75.25",
    );
    const { receipt: r, warnings } = parseReceiptText(S);
    expect(r.serviceAmountCents).toBe(685);
    expect(warnings.join(" ")).toMatch(
      /Service charge is printed as 6\.85, but 10% of 68\.40 is 6\.84/,
    );
    expect(r.uncertainFields).toContain("charges");
  });
});

describe("OCR digit repair is kept but always flagged (owner decision, 7 Nov 2026)", () => {
  const T = `SHOP
Noodles              1O.5O
Green Tea             l.80
Kaya Toast            4.20
Service Charge 10%    l.65
Discount             -O.5O
TOTAL                l7.65`;
  it("repairs the digits and flags each row or charge that used a repaired amount", () => {
    const { receipt: r, warnings } = parseReceiptText(T);
    expect(r.items.map((i) => [i.description, i.lineTotalCents, i.flagged])).toEqual([
      ["Noodles", 1050, true],
      ["Green Tea", 180, true],
      ["Kaya Toast", 420, false],
    ]);
    expect([r.serviceAmountCents, r.discountCents, r.receiptTotalCents]).toEqual([165, 50, 1765]);
    expect(r.uncertainFields).toEqual(expect.arrayContaining(["charges", "discount", "total"]));
    const text = warnings.join("\n");
    for (const printed of ["1O.5O", "l.80", "l.65", "-O.5O", "l7.65"])
      expect(text).toContain(`“${printed}” was read as`);
    expect(text).toMatch(/“1O\.5O” was read as 10\.50/);
    expect(mismatch(T)).toBe(0);
  });
  it("adds no repair warning or flag when every number was printed cleanly", () => {
    const clean = T.replace(/1O\.5O/, "10.50")
      .replace(/l\.80/, "1.80")
      .replace(/l\.65/, "1.65")
      .replace(/-O\.5O/, "-0.50")
      .replace(/l7\.65/, "17.65");
    const { receipt: r, warnings } = parseReceiptText(clean);
    expect(warnings.join(" ")).not.toMatch(/was read as/);
    expect(r.items.some((i) => i.flagged)).toBe(false);
    expect(r.uncertainFields).not.toContain("total");
  });
});
