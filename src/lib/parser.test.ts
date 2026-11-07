import { describe, expect, it } from "vitest";
import { parseReceiptText, scoreParse, splitItemLabel } from "./parser";
import { computeTotals } from "./bill";
import { scoreOcrText } from "./scan-score";

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
    // 1a safety: arithmetic agreement does not confirm the tax-treatment interpretation.
    expect(r.uncertainFields).toContain("charges");
    expect(r.evidence?.gstInclusive).toMatchObject({ origin: "inferred", needsReview: true });
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
    expect(splitItemLabel("LIME JUICE(GST#) I", "auto", false, true)).toMatchObject({ desc: "LIME JUICE", quantity: 1, qtyUncertain: true, taxMarked: true });
  });
});

describe("scoreParse", () => {
  it("prefers the internally consistent pass", () => {
    const good = parseReceiptText(INCLUSIVE).receipt;
    const bad = parseReceiptText(INCLUSIVE.replace("$40.37", "$31.11")).receipt;
    expect(scoreParse(good)).toBeGreaterThan(scoreParse(bad));
  });
});

describe("parser: retail and ticket layouts (invented examples)", () => {
  it("joins split item rows and deducts a repeated savings summary only once", () => {
    const { receipt: r } = parseReceiptText(`EXAMPLE MARKET
ROLLED GRAINS 400G
1 4.00 V
SALTED SPREAD 200G
1 3.00
PAPER BAG 1 0.10
DENTAL PICKS 50M
2 12.00
2 FOR $10.00 2.00-
Total saving 2.00-
Total (SGD) INCL.GST 17.10
GST AMT 1.41
Price payable includes GST
MASTER 17.10`);
    expect(r.items.map((i) => [i.description, i.quantity, i.lineTotalCents])).toEqual([
      ["ROLLED GRAINS 400G", 1, 400], ["SALTED SPREAD 200G", 1, 300],
      ["PAPER BAG 1", 1, 10], ["DENTAL PICKS 50M", 2, 1200],
    ]);
    // 1d: this inline row has no quantity heading; its trailing 1 stays in
    // the description, while the separately printed full amount is retained.
    expect(r.items[2]).toMatchObject({ quantityExact: null, flagged: true });
    expect(r.discountCents).toBe(200);
    expect(r.gstInclusive).toBe(true);
    expect(r.gstAmountCents).toBe(141);
    expect(r.uncertainFields).not.toContain("charges");
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { totalCents: 1710, mismatchCents: 0 } });
  });

  it("reads unit-price and quantity columns without counting the grand total as an item", () => {
    const { receipt: r } = parseReceiptText(`EXAMPLE CINEMA
Item Unit($) Qty Amount
SPACE ADVENTURE (Adult) 12.00 3 36.00
Grand Total(INCL GST) : $36.00
Paid By
Credit 36.00`);
    expect(r.items.map((i) => [i.description, i.quantity, i.lineTotalCents])).toEqual([["SPACE ADVENTURE (Adult)", 3, 3600]]);
    expect(r.gstInclusive).toBe(true);
    expect(r.gstAmountCents).toBeNull();
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { totalCents: 3600, mismatchCents: 0 } });
  });

  it("recognises a leading item count on the total and excludes card payment rows", () => {
    const { receipt: r } = parseReceiptText(`EXAMPLE DRINK SHOP
Qty Descriptions Amount
1 YD-101 Fruit Drink 4.20
1 YD-202 Fruit Drink 4.80
2 TOTAL 9.00
MASTER:XXXX0000[123456] 9.00
CHANGE 0.00`);
    expect(r.items).toHaveLength(2);
    expect(r.items.map((i) => i.quantity)).toEqual([1, 1]);
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { totalCents: 900, mismatchCents: 0 } });
  });

  it("does not mistake product names containing total or master for summary rows", () => {
    const { receipt: r } = parseReceiptText(`Shop
1 TOTAL CARE SHAMPOO 4.00
1 MASTERPIECE TEA 3.00
Total 7.00`);
    // 1c: the unheaded numeric prefix is retained for review, not treated as a
    // proven quantity. Summary words still do not discard either product.
    expect(r.items.map((i) => i.description)).toEqual(["1 TOTAL CARE SHAMPOO", "1 MASTERPIECE TEA"]);
    expect(r.items.every(item => item.quantityExact === null && item.flagged)).toBe(true);
    expect(r.receiptTotalCents).toBe(700);
  });

  it("sums equal independent discounts but never adds their summary", () => {
    const { receipt: r } = parseReceiptText(`Shop
SOAP 1 10.00
Discount 1.00-
Voucher 1.00-
Total savings 2.00-
Total 8.00`);
    expect(r.discountCents).toBe(200);
    expect(r.uncertainFields).not.toContain("discount");
  });

  it("flags a conflicting summary instead of double-counting it", () => {
    const { receipt: r } = parseReceiptText(`Shop\nSOAP 1 10.00\nDiscount 1.00-\nTotal savings 2.00-\nTotal 8.00`);
    expect(r.discountCents).toBe(100);
    expect(r.uncertainFields).toContain("discount");
  });

  it("keeps a standalone savings summary informational and exposes the unresolved discrepancy", () => {
    const { receipt: r } = parseReceiptText(`Shop\nSOAP 1 10.00\nSubtotal 10.00\nTotal savings 2.00-\nGST 0.72\nTotal 8.72`);
    // 1b: previous discount=200 silently deducted a summary without an adjustment.
    expect(r.discountCents).toBe(0);
    expect(r.gstInclusive).toBe(false);
    expect(r.uncertainFields).toContain("charges");
    expect(r.uncertainFields).toContain("discount");
    expect(r.evidence?.gstInclusive).toMatchObject({ origin: "inferred", needsReview: true });
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { mismatchCents: -200 } });
  });

  it("does not attach an orphan price row to a summary or header", () => {
    const { receipt: r } = parseReceiptText(`Shop\nTax Invoice\n1 99.00\nSOAP 1 3.00\nTotal\n1 3.00`);
    expect(r.items.map((i) => i.description)).toEqual(["SOAP 1"]);
    expect(r.items[0]!.quantityExact).toBeNull();
    expect(r.receiptTotalCents).toBeNull();
  });

  it("retains the printed amount and flags inconsistent unit-price arithmetic", () => {
    const { receipt: r } = parseReceiptText(`Shop\nItem Unit($) Qty Amount\nENTRY 4.00 2 7.00\nTotal 7.00`);
    expect(r.items[0]).toMatchObject({ description: "ENTRY", quantity: 2, lineTotalCents: 700, flagged: true });
  });
});

describe("parser: noisy OCR is recovered conservatively (synthetic text)", () => {
  it("retains a ticket descriptor when a damaged final amount follows its unit price", () => {
    const text = "EXAMPLE CINEMA\nUnit($) Qty Amount\nEVENING FILM (Adult) 12.00 | 2 XOO -\nGrand Total (INCL GST) 24.00";
    const r = parseReceiptText(text).receipt;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ description: "EVENING FILM (Adult)", quantity: 1, lineTotalCents: null, flagged: true });
    expect(r.receiptTotalCents).toBe(2400);
    expect(r.uncertainFields).toContain("items");
    expect(scoreOcrText(text).good).toBe(false);
  });
  it("removes repeated tax-marker symbols without changing quantity or amount", () => {
    expect(splitItemLabel("FLATBREAD(GST#*) 2", "auto", false, true)).toMatchObject({ desc: "FLATBREAD", quantity: 2, taxMarked: true });
  });

  it("retains an item with a trailing border after its price", () => {
    const r = parseReceiptText("Shop\n/ DRINK ALPHA 4.20 |\nDRINK BETA 4.80\n2 TOTAL 9.00").receipt;
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ description: "DRINK ALPHA", lineTotalCents: 420, flagged: true });
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { totalCents: 900, mismatchCents: 0 } });
  });

  it("recognises margin noise around GST, savings and total labels", () => {
    const r = parseReceiptText("Shop\nSOAP 1 10.00\n2 FOR $8.00 2.00- /\n4 Total saving | 2.00-\n3 Total (SGD) INCL.GST 8.00 =\nE GST AMT 0.66 E").receipt;
    expect(r.items).toHaveLength(1);
    // 1b: this offer's quantity conflicts with the purchased quantity. A savings
    // summary cannot resolve its role or justify the previous automatic deduction.
    expect(r).toMatchObject({ discountCents: 0, receiptTotalCents: 800, gstAmountCents: 66, gstInclusive: true });
    expect(r.rows?.find((row) => row.text.startsWith("2 FOR"))).toMatchObject({ role: "ambiguous", needsReview: true });
  });

  it("does not turn an ambiguous negative item into a discount", () => {
    const r = parseReceiptText("Shop\nUnit(g) Qty Amount\nSPACE FILM (Adult) 990 3 7 27.00 -\nGrand Total ( INCL GST) © $27.00\nCredit 27.00").receipt;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ description: "SPACE FILM (Adult)", lineTotalCents: null, flagged: true });
    expect(r).toMatchObject({ discountCents: 0, receiptTotalCents: 2700, gstInclusive: true });
    expect(r.uncertainFields).toContain("discount");
    expect(computeTotals(r).ok).toBe(false);
  });

  it.each(["SOAP -3.00", "SOAP 3.00-"])("keeps a possible return unknown: %s", (line) => {
    const r = parseReceiptText(`Shop\n${line}`).receipt;
    expect(r.discountCents).toBe(0);
    expect(r.items[0]).toMatchObject({ lineTotalCents: null, flagged: true });
  });

  it("preserves descriptions and leaves ambiguous numeric columns unknown", () => {
    const r = parseReceiptText("EXAMPLE STORE\nROLLED GRAINS 400G\n: 4.00 V 2\nDENTAL PICKS 50M\n| 2 JNO 4\nTotal 14.00").receipt;
    expect(r.items.map((i) => [i.description, i.lineTotalCents, i.flagged])).toEqual([
      ["ROLLED GRAINS 400G", null, true], ["DENTAL PICKS 50M", null, true],
    ]);
    expect(r.receiptTotalCents).toBe(1400);
    expect(computeTotals(r).ok).toBe(false);
  });

  it("keeps explicit amounts on separate rows while flagging unreadable quantities", () => {
    const text = "EXAMPLE MARKET\nROLLED GRAINS 400G\n[ 4.20 V\nSALTED SPREAD 200G\n| 3.10\nPAPER BAG 1 0.10\nDENTAL PICKS 50M\n: % 230\nTotal 19.40";
    const { receipt: r, warnings } = parseReceiptText(text);
    expect(r.items.map(i => [i.description, i.quantity, i.lineTotalCents, i.flagged])).toEqual([
      ["ROLLED GRAINS 400G", 1, 420, true],
      ["SALTED SPREAD 200G", 1, 310, true],
      ["PAPER BAG 1", 1, 10, true],
      ["DENTAL PICKS 50M", 1, null, true],
    ]);
    expect(r.items[2]!.quantityExact).toBeNull();
    expect(r.uncertainFields).toContain("items");
    expect(warnings.filter(w => w.startsWith("An item has a readable line amount"))).toHaveLength(2);
    expect(scoreOcrText(text).good).toBe(false);
  });

  it.each(["[ 4.20 V", "| 3.10", "4.20"])("does not borrow an orphan decimal from a header or summary: %s", (row) => {
    const r = parseReceiptText(`EXAMPLE SHOP\nTax Invoice\n${row}\nSOAP 1 2.00\nTotal\n${row}\nTotal 2.00\nAFTER PAYMENT\n${row}`).receipt;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ description: "SOAP 1", quantityExact: null, lineTotalCents: 200 });
    expect(r.receiptTotalCents).toBe(200);
  });

  it("does not treat a lone unit price as a line amount in a unit-price layout", () => {
    const r = parseReceiptText("EXAMPLE CINEMA\nItem Unit($) Qty Amount\nEVENING ENTRY\n| 4.20\nTotal 12.60").receipt;
    expect(r.items[0]).toMatchObject({ description: "EVENING ENTRY", lineTotalCents: null, flagged: true });
  });

  it.each(["| 4.20 2", ": 4.20 V 2", ": | 4.20 7"])("leaves an amount with ambiguous trailing quantity columns unknown: %s", (row) => {
    const text = `EXAMPLE SHOP\nROLLED GRAINS 400G\n${row}\nTotal 4.20`;
    const { receipt: r, warnings } = parseReceiptText(text);
    expect(r.items[0]).toMatchObject({ description: "ROLLED GRAINS 400G", quantity: 1, lineTotalCents: null, flagged: true });
    expect(r.uncertainFields).toContain("items");
    expect(warnings).toContain("An item has unreadable quantity/price columns. Confirm its quantity and line amount.");
    expect(scoreOcrText(text).good).toBe(false);
  });

  it.each(["[ 420", "4.20 2", "| 4.20 22", "| 4.20 2 3", "| 2 JNO 4", "[ 4.20 8.40", "| 4.202"])("keeps damaged or multiple numeric columns unknown: %s", (row) => {
    const r = parseReceiptText(`EXAMPLE SHOP\nUNPRICED PRODUCT\n${row}\nTotal 8.40`).receipt;
    expect(r.items[0]).toMatchObject({ description: "UNPRICED PRODUCT", lineTotalCents: null, flagged: true });
  });

  it("does not reinterpret normal quantity rows or unit-price layouts as stray numeric marks", () => {
    const normal = parseReceiptText("EXAMPLE SHOP\nROLLED GRAINS 400G\n2 4.20\nTotal 4.20").receipt;
    expect(normal.items[0]).toMatchObject({ quantity: 2, lineTotalCents: 420, flagged: false });
    const unit = parseReceiptText("EXAMPLE CINEMA\nItem Unit($) Qty Amount\nEVENING ENTRY\n: 4.20 3\nTotal 12.60").receipt;
    expect(unit.items[0]).toMatchObject({ lineTotalCents: null, flagged: true });
    const summary = parseReceiptText("EXAMPLE SHOP\nSOAP 1 2.00\nTotal 2.00\nAFTER PAYMENT\n: 4.20 3").receipt;
    expect(summary.items).toHaveLength(1);
  });

  it.each(["Description Price Qty Amount", "Description Qty Price Amount", "Description Price Quantity Total"])("keeps the missing line amount unknown when a header distinguishes it from price: %s", (header) => {
    const text = `EXAMPLE SHOP\n${header}\nEVENING ENTRY\n| 4.20 2\nTotal 8.40`;
    const { receipt: r } = parseReceiptText(text);
    expect(r.items[0]).toMatchObject({ description: "EVENING ENTRY", lineTotalCents: null, flagged: true });
    expect(scoreOcrText(text).good).toBe(false);
  });

  it("reads complete price-quantity-amount columns with an explicit Price header", () => {
    const r = parseReceiptText("EXAMPLE SHOP\nDescription Price Qty Amount\nEVENING ENTRY 4.20 2 8.40\nTotal 8.40").receipt;
    expect(r.items[0]).toMatchObject({ description: "EVENING ENTRY", quantity: 2, lineTotalCents: 840 });
  });

  it.each(["-4.20", "4.20-", "2 FOR $8.00 2.00-"])("does not join a signed or promotional amount to the preceding item: %s", (row) => {
    const r = parseReceiptText(`EXAMPLE SHOP\nUNPRICED PRODUCT\n${row}\nTotal 8.00`).receipt;
    expect(r.items.every(i => i.lineTotalCents === null)).toBe(true);
  });

  it("does not infer prices from totals or treat a promotion as a quantity row", () => {
    const r = parseReceiptText("Shop\nUNPRICED PRODUCT\n2 FOR $8.00 2.00-\nTotal 8.00").receipt;
    expect(r.items).toHaveLength(0);
    // 1b: an orphan signed promotion does not independently establish a discount.
    expect(r.discountCents).toBe(0);
    expect(r.uncertainFields).toContain("discount");
  });

  it("requests a second OCR pass when flagged fields happen to balance", () => {
    const text = "Shop\nProduct Qty Total\nSOAP I 4.00\nSubtotal 4.00\nGST 0.36\nTotal 4.36";
    expect(computeTotals(parseReceiptText(text).receipt)).toMatchObject({ ok: true, value: { mismatchCents: 0 } });
    expect(scoreOcrText(text).good).toBe(false);
  });
});

