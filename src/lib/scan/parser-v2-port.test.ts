/**
 * parser-v2's parser tests (branch `parser-v2`, commit a80f7e3), ported to `src/lib/scan` in Batch 1b.
 * All synthetic text. Test names follow the originals so each port can be traced; the source file is
 * named in each `describe`.
 *
 * How assertions on parser-v2-only fields were adapted (the rework keeps the approved `Receipt`
 * type, so `quantityExact`, `evidence`, `rows`, `rowKind`, `unitPriceCents` and
 * `suggestedTotalCents` do not exist here):
 *   quantityExact: null      → `flagged: true`, quantity 1 and the number left in the description
 *   quantityExact: {n, 1}    → `quantity: n`
 *   evidence.<field> review  → `uncertainFields` / warnings, where the rework has an equivalent
 *   rows[].role "ambiguous"  → the row is not an item and nothing is deducted for it
 *   scoreOcrText(t).good     → `isConsistent(receipt)` (the rework's "no second pass needed")
 * Behaviour that differs on purpose (owner decisions D2, D4, 7 Nov 2026) is marked "ADAPTED" with
 * the reason. Tests of features not ported (evidence provenance, signed returns, tender-derived
 * totals, quantity defaults) are listed in docs/reports/2026-11-batch1b-real-receipt-fixes.md.
 */
import { describe, expect, it } from "vitest";
import { computeTotals } from "../bill";
import { isConsistent, parseReceiptText, scoreParse, splitItemLabel } from "./parse";

const parse = (t: string) => parseReceiptText(t).receipt;
const rows = (t: string) =>
  parse(t).items.map((i) => [i.description, i.quantity, i.lineTotalCents]);
const QTY_COLUMN = { leading: false, trailing: true };
const mismatch = (t: string) => {
  const c = computeTotals(parse(t));
  return c.ok ? c.value.mismatchCents : "invalid";
};

describe("parser-v2 parser.test.ts: retail and ticket layouts", () => {
  it("joins split item rows and deducts a repeated savings summary only once", () => {
    const T = `EXAMPLE MARKET
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
MASTER 17.10`;
    const r = parse(T);
    // ADAPTED (D2 + parser-v2 safety): the offer matches the item above (2 × DENTAL PICKS, 12.00 −
    // 10.00 = 2.00), so it reduces that item instead of becoming a bill discount. Same total.
    expect(rows(T)).toEqual([
      ["ROLLED GRAINS 400G", 1, 400],
      ["SALTED SPREAD 200G", 1, 300],
      ["PAPER BAG 1", 1, 10],
      ["DENTAL PICKS 50M (2 FOR -2.00)", 2, 1000],
    ]);
    expect(r.items[2]!.flagged).toBe(true); // unheaded trailing "1" stays in the name
    expect(r.discountCents).toBe(0);
    expect(r.gstInclusive).toBe(true);
    expect(r.gstAmountCents).toBe(141);
    expect(computeTotals(r)).toMatchObject({
      ok: true,
      value: { totalCents: 1710, mismatchCents: 0 },
    });
  });

  it("reads unit-price and quantity columns without counting the grand total as an item", () => {
    const T = `EXAMPLE CINEMA
Item Unit($) Qty Amount
SPACE ADVENTURE (Adult) 12.00 3 36.00
Grand Total(INCL GST) : $36.00
Paid By
Credit 36.00`;
    const r = parse(T);
    expect(rows(T)).toEqual([["SPACE ADVENTURE (Adult)", 3, 3600]]);
    expect(r.gstInclusive).toBe(true);
    expect(r.gstAmountCents).toBeNull();
    expect(computeTotals(r)).toMatchObject({
      ok: true,
      value: { totalCents: 3600, mismatchCents: 0 },
    });
  });

  it("recognises a leading item count on the total and excludes card payment rows", () => {
    const r = parse(`EXAMPLE DRINK SHOP
Qty Descriptions Amount
1 YD-101 Fruit Drink 4.20
1 YD-202 Fruit Drink 4.80
2 TOTAL 9.00
MASTER:XXXX0000[123456] 9.00
CHANGE 0.00`);
    expect(r.items).toHaveLength(2);
    expect(r.items.map((i) => i.quantity)).toEqual([1, 1]);
    expect(computeTotals(r)).toMatchObject({
      ok: true,
      value: { totalCents: 900, mismatchCents: 0 },
    });
  });

  it("does not mistake product names containing total or master for summary rows", () => {
    const r = parse(`Shop
1 TOTAL CARE SHAMPOO 4.00
1 MASTERPIECE TEA 3.00
Total 7.00`);
    expect(r.items.map((i) => i.description)).toEqual([
      "1 TOTAL CARE SHAMPOO",
      "1 MASTERPIECE TEA",
    ]);
    expect(r.items.every((item) => item.flagged)).toBe(true);
    expect(r.receiptTotalCents).toBe(700);
  });

  it("sums equal independent discounts but never adds their summary", () => {
    const r = parse(`Shop
SOAP 1 10.00
Discount 1.00-
Voucher 1.00-
Total savings 2.00-
Total 8.00`);
    // ADAPTED (D2): both discounts are printed directly under SOAP, so they reduce SOAP.
    expect(r.items[0]!.lineTotalCents).toBe(800);
    expect(r.discountCents).toBe(0);
    expect(r.uncertainFields).not.toContain("discount");
  });

  it("flags a conflicting summary instead of double-counting it", () => {
    const r = parse(`Shop\nSOAP 1 10.00\nDiscount 1.00-\nTotal savings 2.00-\nTotal 8.00`);
    // ADAPTED (D2): the 1.00 reduces SOAP; the 2.00 summary is never deducted again.
    expect(r.items[0]!.lineTotalCents).toBe(900);
    expect(r.discountCents).toBe(0);
    expect(r.uncertainFields).toContain("discount");
  });

  it("keeps a standalone savings summary informational and exposes the unresolved discrepancy", () => {
    const r = parse(
      `Shop\nSOAP 1 10.00\nSubtotal 10.00\nTotal savings 2.00-\nGST 0.72\nTotal 8.72`,
    );
    expect(r.discountCents).toBe(0);
    expect(r.gstInclusive).toBe(false);
    expect(r.uncertainFields).toContain("charges");
    expect(r.uncertainFields).toContain("discount");
    expect(computeTotals(r)).toMatchObject({ ok: true, value: { mismatchCents: -200 } });
  });

  it("does not attach an orphan price row to a summary or header", () => {
    const r = parse(`Shop\nTax Invoice\n1 99.00\nSOAP 1 3.00\nTotal\n1 3.00`);
    expect(r.items.map((i) => i.description)).toEqual(["SOAP 1"]);
    expect(r.items[0]!.flagged).toBe(true);
    expect(r.receiptTotalCents).toBeNull();
  });

  it("retains the printed amount and flags inconsistent unit-price arithmetic", () => {
    const r = parse(`Shop\nItem Unit($) Qty Amount\nENTRY 4.00 2 7.00\nTotal 7.00`);
    expect(r.items[0]).toMatchObject({
      description: "ENTRY",
      quantity: 2,
      lineTotalCents: 700,
      flagged: true,
    });
  });
});

describe("parser-v2 parser.test.ts: noisy OCR is recovered conservatively", () => {
  it("retains a ticket descriptor when a damaged final amount follows its unit price", () => {
    const text =
      "EXAMPLE CINEMA\nUnit($) Qty Amount\nEVENING FILM (Adult) 12.00 | 2 XOO -\nGrand Total (INCL GST) 24.00";
    const r = parse(text);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      description: "EVENING FILM (Adult)",
      quantity: 1,
      lineTotalCents: null,
      flagged: true,
    });
    expect(r.receiptTotalCents).toBe(2400);
    expect(r.uncertainFields).toContain("items");
    expect(isConsistent(r)).toBe(false);
  });

  it("removes repeated tax-marker symbols without changing quantity or amount", () => {
    expect(splitItemLabel("FLATBREAD(GST#*) 2", QTY_COLUMN)).toMatchObject({
      desc: "FLATBREAD",
      quantity: 2,
      taxMarked: true,
    });
  });

  it("retains an item with a trailing border after its price", () => {
    const r = parse("Shop\n/ DRINK ALPHA 4.20 |\nDRINK BETA 4.80\n2 TOTAL 9.00");
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ description: "DRINK ALPHA", lineTotalCents: 420 });
    expect(computeTotals(r)).toMatchObject({
      ok: true,
      value: { totalCents: 900, mismatchCents: 0 },
    });
  });

  it("recognises margin noise around GST, savings and total labels", () => {
    const r = parse(
      "Shop\nSOAP 1 10.00\n2 FOR $8.00 2.00- /\n4 Total saving | 2.00-\n3 Total (SGD) INCL.GST 8.00 =\nE GST AMT 0.66 E",
    );
    expect(r.items).toHaveLength(1);
    // The offer's quantity (2) is not the item's printed quantity, so it is not deducted.
    expect(r).toMatchObject({
      discountCents: 0,
      receiptTotalCents: 800,
      gstAmountCents: 66,
      gstInclusive: true,
    });
    expect(r.items[0]!.lineTotalCents).toBe(1000);
    expect(r.uncertainFields).toContain("discount");
  });

  it("does not turn an ambiguous negative item into a discount", () => {
    const r = parse(
      "Shop\nUnit(g) Qty Amount\nSPACE FILM (Adult) 990 3 7 27.00 -\nGrand Total ( INCL GST) © $27.00\nCredit 27.00",
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ lineTotalCents: null, flagged: true });
    expect(r.items[0]!.description).toMatch(/^SPACE FILM \(Adult\)/);
    expect(r).toMatchObject({ discountCents: 0, receiptTotalCents: 2700, gstInclusive: true });
    expect(r.uncertainFields).toContain("discount");
    expect(computeTotals(r).ok).toBe(false);
  });

  it.each(["SOAP -3.00", "SOAP 3.00-"])("keeps a possible return unknown: %s", (line) => {
    const r = parse(`Shop\n${line}`);
    expect(r.discountCents).toBe(0);
    expect(r.items[0]).toMatchObject({ lineTotalCents: null, flagged: true });
  });

  it("preserves descriptions and leaves ambiguous numeric columns unknown", () => {
    const r = parse(
      "EXAMPLE STORE\nROLLED GRAINS 400G\n: 4.00 V 2\nDENTAL PICKS 50M\n| 2 JNO 4\nTotal 14.00",
    );
    expect(r.items.map((i) => [i.description, i.lineTotalCents, i.flagged])).toEqual([
      ["ROLLED GRAINS 400G", null, true],
      ["DENTAL PICKS 50M", null, true],
    ]);
    expect(r.receiptTotalCents).toBe(1400);
    expect(computeTotals(r).ok).toBe(false);
  });

  it("keeps explicit amounts on separate rows while flagging unreadable quantities", () => {
    const text =
      "EXAMPLE MARKET\nROLLED GRAINS 400G\n[ 4.20 V\nSALTED SPREAD 200G\n| 3.10\nPAPER BAG 1 0.10\nDENTAL PICKS 50M\n: % 230\nTotal 19.40";
    const { receipt: r, warnings } = parseReceiptText(text);
    expect(r.items.map((i) => [i.description, i.quantity, i.lineTotalCents, i.flagged])).toEqual([
      ["ROLLED GRAINS 400G", 1, 420, true],
      ["SALTED SPREAD 200G", 1, 310, true],
      ["PAPER BAG 1", 1, 10, true],
      ["DENTAL PICKS 50M", 1, null, true],
    ]);
    expect(r.uncertainFields).toContain("items");
    expect(warnings.filter((w) => w.startsWith("An item has a readable line amount"))).toHaveLength(
      2,
    );
    expect(isConsistent(r)).toBe(false);
  });

  it.each(["[ 4.20 V", "| 3.10", "4.20"])(
    "does not borrow an orphan decimal from a header or summary: %s",
    (row) => {
      const r = parse(
        `EXAMPLE SHOP\nTax Invoice\n${row}\nSOAP 1 2.00\nTotal\n${row}\nTotal 2.00\nAFTER PAYMENT\n${row}`,
      );
      expect(r.items).toHaveLength(1);
      expect(r.items[0]).toMatchObject({
        description: "SOAP 1",
        flagged: true,
        lineTotalCents: 200,
      });
      expect(r.receiptTotalCents).toBe(200);
    },
  );

  it("does not treat a lone unit price as a line amount in a unit-price layout", () => {
    const r = parse("EXAMPLE CINEMA\nItem Unit($) Qty Amount\nEVENING ENTRY\n| 4.20\nTotal 12.60");
    expect(r.items[0]).toMatchObject({
      description: "EVENING ENTRY",
      lineTotalCents: null,
      flagged: true,
    });
  });

  it.each(["| 4.20 2", ": 4.20 V 2", ": | 4.20 7"])(
    "leaves an amount with ambiguous trailing quantity columns unknown: %s",
    (row) => {
      const text = `EXAMPLE SHOP\nROLLED GRAINS 400G\n${row}\nTotal 4.20`;
      const { receipt: r, warnings } = parseReceiptText(text);
      expect(r.items[0]).toMatchObject({
        description: "ROLLED GRAINS 400G",
        quantity: 1,
        lineTotalCents: null,
        flagged: true,
      });
      expect(r.uncertainFields).toContain("items");
      expect(warnings).toContain(
        "An item has unreadable quantity/price columns. Confirm its quantity and line amount.",
      );
      expect(isConsistent(r)).toBe(false);
    },
  );

  it.each(["[ 420", "4.20 2", "| 4.20 22", "| 4.20 2 3", "| 2 JNO 4", "[ 4.20 8.40", "| 4.202"])(
    "keeps damaged or multiple numeric columns unknown: %s",
    (row) => {
      const r = parse(`EXAMPLE SHOP\nUNPRICED PRODUCT\n${row}\nTotal 8.40`);
      expect(r.items[0]).toMatchObject({
        description: "UNPRICED PRODUCT",
        lineTotalCents: null,
        flagged: true,
      });
    },
  );

  it("does not reinterpret normal quantity rows or unit-price layouts as stray numeric marks", () => {
    const normal = parse("EXAMPLE SHOP\nROLLED GRAINS 400G\n2 4.20\nTotal 4.20");
    expect(normal.items[0]).toMatchObject({ quantity: 2, lineTotalCents: 420, flagged: false });
    const unit = parse(
      "EXAMPLE CINEMA\nItem Unit($) Qty Amount\nEVENING ENTRY\n: 4.20 3\nTotal 12.60",
    );
    expect(unit.items[0]).toMatchObject({ lineTotalCents: null, flagged: true });
    const summary = parse("EXAMPLE SHOP\nSOAP 1 2.00\nTotal 2.00\nAFTER PAYMENT\n: 4.20 3");
    expect(summary.items).toHaveLength(1);
  });

  it.each([
    "Description Price Qty Amount",
    "Description Qty Price Amount",
    "Description Price Quantity Total",
  ])(
    "keeps the missing line amount unknown when a header distinguishes it from price: %s",
    (header) => {
      const text = `EXAMPLE SHOP\n${header}\nEVENING ENTRY\n| 4.20 2\nTotal 8.40`;
      const r = parse(text);
      expect(r.items[0]).toMatchObject({
        description: "EVENING ENTRY",
        lineTotalCents: null,
        flagged: true,
      });
      expect(isConsistent(r)).toBe(false);
    },
  );

  it("reads complete price-quantity-amount columns with an explicit Price header", () => {
    const r = parse(
      "EXAMPLE SHOP\nDescription Price Qty Amount\nEVENING ENTRY 4.20 2 8.40\nTotal 8.40",
    );
    expect(r.items[0]).toMatchObject({
      description: "EVENING ENTRY",
      quantity: 2,
      lineTotalCents: 840,
    });
  });

  it.each(["-4.20", "4.20-", "2 FOR $8.00 2.00-"])(
    "does not join a signed or promotional amount to the preceding item: %s",
    (row) => {
      const r = parse(`EXAMPLE SHOP\nUNPRICED PRODUCT\n${row}\nTotal 8.00`);
      expect(r.items.every((i) => i.lineTotalCents === null)).toBe(true);
    },
  );

  it("does not infer prices from totals or treat a promotion as a quantity row", () => {
    const r = parse("Shop\nUNPRICED PRODUCT\n2 FOR $8.00 2.00-\nTotal 8.00");
    // ADAPTED: in a receipt with no item heading, an unpriced line above the first item is header
    // text, so no item is created (parser-v2 also created none). Nothing is deducted.
    expect(r.items).toHaveLength(0);
    expect(r.discountCents).toBe(0);
    expect(r.uncertainFields).toContain("discount");
  });

  it("requests a second OCR pass when flagged fields happen to balance", () => {
    const text = "Shop\nProduct Qty Total\nSOAP I 4.00\nSubtotal 4.00\nGST 0.36\nTotal 4.36";
    expect(computeTotals(parse(text))).toMatchObject({ ok: true, value: { mismatchCents: 0 } });
    // ADAPTED: the rework's second pass is decided by `isConsistent`, which accepts a balanced
    // receipt with a flagged item; the flag itself stays for the user.
    expect(parse(text).items[0]).toMatchObject({ quantity: 1, flagged: true });
  });

  it("scoreParse prefers the internally consistent pass", () => {
    const INCLUSIVE = `SAMPLE CURRY HOUSE\nProduct Qty Total\nFLATBREAD(GST*) 2 $6.00\nSales Amount $5.50\nTotal tax $0.50\nAmount $6.00`;
    expect(scoreParse(parse(INCLUSIVE))).toBeGreaterThan(
      scoreParse(parse(INCLUSIVE.replace("$5.50", "$1.11"))),
    );
  });
});

describe("parser-v2 parser-interpretation.test.ts", () => {
  const p = (body: string) => parse(`EXAMPLE MERCHANT\n${body}`);

  it("normalises OCR total labels while preserving product names and literal source", () => {
    const r = p("Description Qty Amount\nT0TAL CARE 500ml 1 4.00\nT0TAI 4.00");
    expect(r.items[0]).toMatchObject({ description: "T0TAL CARE 500ml", lineTotalCents: 400 });
    expect(r.receiptTotalCents).toBe(400);
    expect(r.rawOcrText).toContain("T0TAI 4.00");
  });

  it("limits confusion substitutions to summary labels", () => {
    const r = p(
      "Description Qty Amount\nSOAP 1 10.00\nSubtotal 10.00\nD1SC0UNT 2.00-\nT0TA| 8.00\nGST 1O.00",
    );
    // ADAPTED: a Subtotal line is added so D2 doesn't attach the discount to SOAP.
    expect(r.discountCents).toBe(200);
    expect(r.receiptTotalCents).toBe(800);
    // ADAPTED (differs from parser-v2, raised with the owner): the rework has always repaired O→0
    // inside amounts ("1O.5O" → 10.50, see receipt-types "OCR noise"), so "1O.00" reads as 10.00.
    // The charge check (P5) then flags it: 9% of 8.00 is not 10.00.
    expect(r.gstAmountCents).toBe(1000);
    expect(r.uncertainFields).toContain("charges");
  });

  it("recognises a confused GST label without changing its numeric rate", () => {
    const r = p("Description Qty Amount\nSOAP 1 10.00\nG5T 5% 0.50\nTotal 10.50");
    expect(r.gstAmountCents).toBe(50);
    expect(r.gstRateBp).toBe(500);
    const signed = p("SOAP 1 10.00\nService -1.00\nGST 0.50- F\nTotal 8.50");
    expect(signed.serviceAmountCents).toBeNull();
    expect(signed.gstAmountCents).toBeNull();
    expect(signed.uncertainFields).toContain("charges");
  });

  it("accepts financial-label separators without changing literal evidence or product text", () => {
    const r = p(
      "Description Qty Amount\nCODE; SOAP 1 10.00\nGST AMT;0.90\nService Charge= 1.00\nTotal:11.90",
    );
    expect(r.items[0]!.description).toBe("CODE SOAP");
    expect(r.gstAmountCents).toBe(90);
    expect(r.serviceAmountCents).toBe(100);
    expect(r.receiptTotalCents).toBe(1190);
  });

  it("accepts an isolated currency marker only after a complete financial label", () => {
    const r = p("SOAP 1 10.00\nTotal GST S $0.90\nService Charge SGD $1.00\nTotal S $11.90");
    expect(r.gstAmountCents).toBe(90);
    expect(r.serviceAmountCents).toBe(100);
    expect(r.receiptTotalCents).toBe(1190);
  });

  it("keeps a savings summary informational without an independent adjustment", () => {
    const r = p("SOAP 1 8.00\nTotal savings 2.00\nTotal 8.00");
    expect(r.discountCents).toBe(0);
    expect(r.uncertainFields).toContain("discount");
    expect(r.items).toHaveLength(1);
  });

  it("deducts independent discount rows once when their savings summary repeats them", () => {
    const r = p("SOAP 1 10.00\nDiscount 2.00-\nTotal savings 2.00\nTotal 8.00");
    // ADAPTED (D2): the discount under SOAP reduces SOAP; the summary is not deducted again.
    expect(r.items[0]!.lineTotalCents).toBe(800);
    expect(r.discountCents).toBe(0);
    expect(r.uncertainFields).not.toContain("discount");
    expect(
      mismatch(`EXAMPLE MERCHANT\nSOAP 1 10.00\nDiscount 2.00-\nTotal savings 2.00\nTotal 8.00`),
    ).toBe(0);
  });

  it("retains purchased offer descriptions with punctuation and package sizes", () => {
    const r = p(
      "Description Qty Amount\n2.FOR JUICE 500ml 1 6.00\n2-FOR SOAP 2-pack 1 4.00\n2 FOR TEA 1 3.00\nTotal 13.00",
    );
    expect(r.items.map((item) => item.description)).toEqual([
      "2.FOR JUICE 500ml",
      "2-FOR SOAP 2-pack",
      "2 FOR TEA",
    ]);
    expect(r.discountCents).toBe(0);
  });

  it("does not turn a bare positive offer into a product or discount", () => {
    const r = p("SOAP 1 8.00\n2.FOR $8.00\nTotal 8.00");
    expect(r.items).toHaveLength(1);
    expect(r.discountCents).toBe(0);
  });

  it("retains an unsupported signed offer as an ambiguous financial row", () => {
    const r = p("SOAP 1 10.00\n2-FOR $8.00 2.00-\nTotal 8.00");
    expect(r.discountCents).toBe(0);
    expect(r.items[0]!.lineTotalCents).toBe(1000);
    expect(r.uncertainFields).toContain("discount");
  });

  it("records a supported separately signed offer adjustment with inferred role and review", () => {
    const r = p("2 x SOAP 10.00\n2 FOR $8.00 2.00-\nTotal savings 2.00\nTotal 8.00");
    // ADAPTED (D2 + parser-v2 safety): the matching offer reduces SOAP rather than the bill.
    expect(r.items[0]).toMatchObject({ quantity: 2, lineTotalCents: 800, flagged: true });
    expect(r.discountCents).toBe(0);
    expect(r.uncertainFields).toContain("discount");
  });

  it("retains the original unheaded offer case without unsupported quantity certainty or deduction", () => {
    const r = p("SOAP 2 10.00\n2 FOR $8.00 2.00-\nTotal savings 2.00\nTotal 8.00");
    expect(r.items[0]).toMatchObject({
      description: "SOAP 2",
      quantity: 1,
      lineTotalCents: 1000,
      flagged: true,
    });
    expect(r.discountCents).toBe(0);
    expect(r.uncertainFields).toContain("discount");
  });

  it("does not turn an unexplained negative product into a discount", () => {
    const r = p("SOAP 1 -4.00\nTotal 4.00");
    expect(r.discountCents).toBe(0);
    expect(r.items[0]).toMatchObject({ lineTotalCents: null, flagged: true });
  });

  it("retains a supported product after an apparent total rather than discarding the remainder", () => {
    const r = p("1 x SOAP 4.00\nTotal 4.00\n2 x TEA 3.00\nPayNow 7.00");
    expect(r.items.map((item) => item.description)).toEqual(["SOAP", "TEA"]);
    expect(r.receiptTotalCents).toBe(400);
  });

  it("retains the original unheaded post-total numeric row for review without inventing its role", () => {
    const { receipt: r, warnings } = parseReceiptText(
      "EXAMPLE MERCHANT\nSOAP 1 4.00\nTotal 4.00\nTEA 2 3.00\nPayNow 7.00",
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ description: "SOAP 1", lineTotalCents: 400, flagged: true });
    expect(r.receiptTotalCents).toBe(400);
    expect(warnings.join(" ")).toMatch(/Lines not used: “TEA 2 3.00”/);
  });

  it("does not classify an unknown post-summary amount as a product", () => {
    const { receipt: r, warnings } = parseReceiptText(
      "EXAMPLE MERCHANT\nSOAP 1 4.00\nTotal 4.00\nUNKNOWN LABEL 3.00",
    );
    expect(r.items).toHaveLength(1);
    expect(warnings.join(" ")).toMatch(/UNKNOWN LABEL 3.00/);
  });

  it("preserves numeric identifiers while separating explicit unit/quantity/amount columns", () => {
    const r = p("Description Unit($) Qty Amount\nMODEL 42 500ml 3.00 2 6.00\nTotal 6.00");
    expect(r.items[0]).toMatchObject({
      description: "MODEL 42 500ml",
      quantity: 2,
      lineTotalCents: 600,
    });
    expect(p("Noodles No 8 3.50").items[0]).toMatchObject({ description: "Noodles No 8" });
    expect(p("1 Noodles No 8 3.50").items[0]).toMatchObject({
      description: "1 Noodles No 8",
      lineTotalCents: 350,
      flagged: true,
    });
    expect(p("1 x Noodles No 8 3.50").items[0]).toMatchObject({
      description: "Noodles No 8",
      quantity: 1,
    });
    expect(p("Item Bag 2.00").items[0]).toMatchObject({
      description: "Item Bag",
      lineTotalCents: 200,
    });
  });

  it("supports quantity-before-unit-price column order", () => {
    const r = p("Description Qty Unit Price Amount\nMODEL 42 2 3.00 6.00\nTotal 6.00");
    expect(r.items[0]).toMatchObject({ description: "MODEL 42", quantity: 2, lineTotalCents: 600 });
  });

  it("accepts a finite quantity-label confusion only in a complete unit/amount heading", () => {
    const r = p("Unit($) qiy Amount\nCONCERT 12.00 2 24.00\nTotal 24.00");
    expect(r.items[0]).toMatchObject({
      description: "CONCERT",
      quantity: 2,
      lineTotalCents: 2400,
      flagged: false,
    });
  });

  it("suggests a missing quantity only from exact, identified same-row prices with retained review", () => {
    const r = p("Description Unit($) Qty Amount\nCOFFEE 3.00 ? 6.00\nTotal 6.00");
    expect(r.items[0]).toMatchObject({
      description: "COFFEE",
      quantity: 2,
      lineTotalCents: 600,
      flagged: true,
    });
  });

  it("does not reinterpret unsupported receipt currency as observed SGD", () => {
    const r = p("Currency USD\nSOAP 1 4.00\nTotal USD 4.00");
    expect(r.currency).toBe("SGD");
    expect(r.uncertainFields).toContain("currency");
  });

  it("does not equate split payments or cash/change with a printed total", () => {
    expect(p("SOAP 1 4.00\nVisa 2.00\nPayNow 2.00").receiptTotalCents).toBeNull();
    expect(p("SOAP 1 4.00\nCash 10.00\nChange 6.00").receiptTotalCents).toBeNull();
    expect(p("SOAP 1 4.00\nVisa 4.00").receiptTotalCents).toBeNull();
  });

  it("keeps conflicting printed totals flagged", () => {
    const r = p("SOAP 1 4.00\nT0TAL 4.00\nTOTAL DUE 5.00");
    // ADAPTED: the rework keeps its "last total before payment" rule (parser-v2 kept the first);
    // either way the conflict is flagged and nothing is changed to reconcile it.
    expect(r.receiptTotalCents).toBe(500);
    expect(r.uncertainFields).toContain("total");
  });

  it("does not join damaged numeric fragments to an unpriced financial note", () => {
    const r = p(
      "SOAP 1 4.00\nTEA 1 3.00\nTotal GST AMT DETAILS 9 £ 90 unreadable\n: 9 90\nTotal 7.00",
    );
    expect(r.items.map((item) => item.description)).toEqual(["SOAP 1", "TEA 1"]);
    expect(r.items.every((item) => item.flagged)).toBe(true);
    const products = p("TAX-FREE COLA 500ml\n1 4.00\nGST COLA 500ml\n1 3.00\nTotal 7.00");
    expect(products.items.map((item) => item.description)).toEqual([
      "TAX-FREE COLA 500ml",
      "GST COLA 500ml",
    ]);
  });
});

describe("parser-v2 parser-safety.test.ts", () => {
  it("retains observed integer quantities", () => {
    const r = parse("Example Store\nDescription Qty Amount\nCoffee 2 8.00\nTotal 8.00");
    expect(r.items[0]).toMatchObject({ quantity: 2, lineTotalCents: 800, flagged: false });
    expect(r.uncertainFields).not.toContain("items");
  });

  it("does not turn an OCR quantity glyph into an observed one", () => {
    expect(splitItemLabel("Coffee I")).toMatchObject({
      quantity: 1,
      qtyObserved: false,
      qtyUncertain: true,
    });
    const r = parse("Example Store\nDescription Qty Amount\nCoffee I 4.00\nTotal 4.00");
    expect(r.items[0]).toMatchObject({ description: "Coffee", quantity: 1, flagged: true });
  });

  it("retains all existing fields and flags a conflicting identifiable price relationship", () => {
    const r = parse(
      "Example Store\nDescription Unit Price Qty Amount\nCoffee 3.00 2 7.00\nTotal 7.00",
    );
    expect(r.items[0]).toMatchObject({
      description: "Coffee",
      quantity: 2,
      lineTotalCents: 700,
      flagged: true,
    });
  });

  it("records an agreeing relationship without flagging it", () => {
    const r = parse(
      "Example Store\nDescription Unit Price Qty Amount\nCoffee 3.00 2 6.00\nTotal 6.00",
    );
    expect(r.items[0]).toMatchObject({ quantity: 2, lineTotalCents: 600, flagged: false });
  });

  it("keeps a savings summary separate from an unconfirmed discount adjustment", () => {
    const r = parse(
      "Example Store\nDescription Qty Amount\nCoffee 1 4.00\nTotal savings 1.00\nTotal 4.00",
    );
    expect(r.discountCents).toBe(0);
    expect(r.uncertainFields).toContain("discount");
  });

  it("records explicitly printed zero charges and discount without inventing amounts", () => {
    const r = parse(
      "Example Store\nDescription Qty Amount\nCoffee 1 4.00\nDiscount 0.00\nService 0.00\nGST 0.00\nTotal 4.00",
    );
    expect(r).toMatchObject({
      discountCents: 0,
      serviceAmountCents: 0,
      gstAmountCents: 0,
      receiptTotalCents: 400,
    });
  });

  it("distinguishes printed charge rates", () => {
    const r = parse(
      "Example Store\nDescription Qty Amount\nCoffee 1 10.00\nService 10% 1.00\nGST 0.99\nTotal 11.99",
    );
    expect(r.serviceRateBp).toBe(1000);
    expect(r.gstAmountCents).toBe(99);
  });

  it("does not manufacture a printed total from a balanced sum", () => {
    const r = parse("Example Store\nDescription Qty Amount\nCoffee 1 4.00");
    expect(r.receiptTotalCents).toBeNull();
    expect(r.uncertainFields).toContain("total");
  });

  it("joins a supported split row", () => {
    const r = parse("Example Store\n\nDescription Qty Amount\nCoffee\n2 8.00\nTotal 8.00");
    expect(r.items[0]).toMatchObject({ description: "Coffee", quantity: 2, lineTotalCents: 800 });
  });

  it("keeps unreadable numeric values unknown and reviewable", () => {
    const r = parse(
      "Example Store\nDescription Unit Price Qty Amount\nConcert Pass 12.00 ? BAD\nTotal 24.00",
    );
    expect(r.items[0]).toMatchObject({
      description: "Concert Pass",
      quantity: 1,
      lineTotalCents: null,
      flagged: true,
    });
  });
});

describe("parser-v2 batch1c-parser.test.ts: numeric product identity", () => {
  it.each(["100 PLUS", "42 VITAMIN", "7 NOODLES"])(
    "preserves unsupported numeric prefixes: %s",
    (name) => {
      expect(parse(`SHOP\n${name} 3.50\nTotal 3.50`).items[0]).toMatchObject({
        description: name,
        flagged: true,
      });
    },
  );

  it("preserves numeric prefixes on damaged split lines without inventing quantity", () => {
    const r = parse("SHOP\n100 PLUS\n3 4.00 V F\nTotal 4.00");
    expect(r.items[0]).toMatchObject({ description: "100 PLUS", lineTotalCents: null });
  });

  it("uses explicit multiplication or a quantity heading while keeping numeric product names", () => {
    expect(parse("SHOP\n2 x 100 PLUS 7.00").items[0]).toMatchObject({
      description: "100 PLUS",
      quantity: 2,
    });
    expect(parse("SHOP\nProduct Qty Total\n100 PLUS 2 7.00").items[0]).toMatchObject({
      description: "100 PLUS",
      quantity: 2,
    });
  });

  it("retains labelled tax plus one isolated margin token", () => {
    const r = parse(
      "SHOP\nProduct Qty Total\nSOAP 1 26.00\nSales Amount 23.66\nTotal tax X $2.34\nTotal 26.00",
    );
    expect(r.gstAmountCents).toBe(234);
    expect(r.gstInclusive).toBe(true);
    expect(
      parse("SHOP\nProduct Qty Total\nGST FREE COLA 1 4.00\nTotal 4.00").items[0]!.description,
    ).toBe("GST FREE COLA");
  });
});

describe("parser-v2 trailing-quantity.batch1d.test.ts: trailing numbers require quantity evidence", () => {
  it.each([
    "VITAMIN B 12",
    "PAINT SHADE 42",
    "MODEL 12",
    "PACK 12",
    "RICE 250g",
    "100 PLUS",
    "7 NOODLES",
  ])("preserves an unheaded numeric identity: %s", (name) => {
    const r = parse(`EXAMPLE MERCHANT\n${name} 8.00\nTotal 8.00`);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ description: name, quantity: 1, lineTotalCents: 800 });
  });

  it.each([
    ["2 x VITAMIN B 12 16.00", "VITAMIN B 12", 2, 1600],
    ["Description Qty Amount\nVITAMIN B 12 2 16.00", "VITAMIN B 12", 2, 1600],
    ["Qty Description Amount\n2 VITAMIN B 12 16.00", "VITAMIN B 12", 2, 1600],
    ["Description Qty Amount\nMILK 500ml 2 6.00", "MILK 500ml", 2, 600],
    ["Description Qty Amount\nBATTERIES 4-pack 2 8.00", "BATTERIES 4-pack", 2, 800],
  ] as const)(
    "preserves explicit multiplication and supported quantity columns: %s",
    (body, name, qty, amount) => {
      expect(parse(`EXAMPLE MERCHANT\n${body}`).items[0]).toMatchObject({
        description: name,
        quantity: qty,
        lineTotalCents: amount,
      });
    },
  );

  it("retains an independently shaped split quantity and amount row", () => {
    expect(parse("EXAMPLE MERCHANT\nVITAMIN B 12\n2 16.00").items[0]).toMatchObject({
      description: "VITAMIN B 12",
      quantity: 2,
      lineTotalCents: 1600,
    });
  });

  it("does not mine damaged split numeric fragments", () => {
    expect(parse("EXAMPLE MERCHANT\nVITAMIN B 12\n3 4.00 V F").items[0]).toMatchObject({
      description: "VITAMIN B 12",
      lineTotalCents: null,
      flagged: true,
    });
  });

  it.each([
    "Description Unit Price Qty Amount\nCOFFEE 3.50 2 7.00",
    "Description Qty Unit Price Amount\nCOFFEE 2 3.50 7.00",
  ])("keeps headed unit price distinct from the full amount: %s", (body) => {
    // ADAPTED (WO-004, D16): a printed total is added; with none read, every row is flagged.
    expect(parse(`EXAMPLE MERCHANT\n${body}\nTOTAL 7.00`).items[0]).toMatchObject({
      description: "COFFEE",
      quantity: 2,
      lineTotalCents: 700,
      flagged: false,
    });
  });

  it("preserves an independent full amount after an explicit @ unit price", () => {
    // ADAPTED (WO-004, D16): a printed total is added; with none read, every row is flagged.
    expect(parse("EXAMPLE MERCHANT\nCOFFEE 2 @ 3.50 7.00\nTOTAL 7.00").items[0]).toMatchObject({
      description: "COFFEE",
      quantity: 2,
      lineTotalCents: 700,
      flagged: false,
    });
  });

  it("preserves and flags a full-amount mismatch without repairing it", () => {
    expect(parse("EXAMPLE MERCHANT\nCOFFEE 2 @ 3.50 6.50").items[0]).toMatchObject({
      description: "COFFEE",
      quantity: 2,
      lineTotalCents: 650,
      flagged: true,
    });
  });

  it("does not reinterpret a trailing numeric product identifier after explicit leading multiplication", () => {
    expect(parse("EXAMPLE MERCHANT\n2 x VITAMIN B 12 @ $3.50 7.00").items[0]).toMatchObject({
      description: "VITAMIN B 12",
      quantity: 2,
      lineTotalCents: 700,
    });
  });
});

describe("parser-v2 receipt-rounding.test.ts: rounding detection (applied per D4)", () => {
  const T = (rows: string) =>
    `SYNTHETIC SHOP\n1 x Synthetic product 10.00\nTotal 10.00\n${rows}\nTotal Due PLACEHOLDER`;
  const withDue = (rows: string, due: string) =>
    parseReceiptText(T(rows).replace("PLACEHOLDER", due));

  it.each([
    ["-0.02", "9.98", -2],
    ["+0.02", "10.02", 2],
    ["-0.05", "9.95", -5],
  ] as const)("applies an explicit signed rounding of at most 5 cents: %s", (row, due, cents) => {
    const { receipt: r, warnings } = withDue(`Cash rounding ${row}`, due);
    // ADAPTED (D4): splitting uses the unrounded total; the rounding shows as a warning.
    expect(r.receiptTotalCents).toBe(1000);
    expect(warnings.join(" ")).toMatch(
      new RegExp(`rounded the payable amount by ${(cents / 100).toFixed(2).replace(".", "\\.")}`),
    );
  });

  it("does not apply a rounding over 5 cents", () => {
    const { receipt: r, warnings } = withDue("Bill rounding -0.06", "9.94");
    expect(r.receiptTotalCents).toBe(994);
    expect(r.uncertainFields).toContain("total");
    expect(warnings.join(" ")).toMatch(/more than 5 cents/);
  });

  it.each([
    "Rounding -0.02\nRounding -0.02",
    "Rounding -0.02\nRounding +0.02",
    "Rounding -0.02\nRounding -0.03",
  ])("retains repeated or conflicting rows rather than summing or deduplicating: %s", (rows) => {
    const { receipt: r, warnings } = withDue(rows, "9.98");
    expect(r.receiptTotalCents).toBe(998);
    expect(r.uncertainFields).toContain("total");
    expect(warnings.join(" ")).toMatch(/More than one rounding line/);
  });

  it("keeps a missing sign unresolved", () => {
    const { receipt: r, warnings } = withDue("Cash rounding 0.02", "10.02");
    expect(r.receiptTotalCents).toBe(1002);
    expect(r.uncertainFields).toContain("total");
    expect(warnings.join(" ")).toMatch(/no readable sign/);
  });

  it("accepts readable zero, trailing minus and negative parentheses", () => {
    expect(withDue("Rounding 0.00", "10.00").receipt.receiptTotalCents).toBe(1000);
    expect(withDue("Round off 0.02-", "9.98").receipt.receiptTotalCents).toBe(1000);
    expect(withDue("Rounding adjustment (0.02)", "9.98").receipt.receiptTotalCents).toBe(1000);
  });

  it("does not identify products merely containing rounding words", () => {
    expect(parse("SHOP\nROUND BISCUITS 3.00\nTotal 3.00").items[0]!.description).toBe(
      "ROUND BISCUITS",
    );
    expect(parse("SHOP\nRounding biscuits 3.00\nTotal 3.00").items[0]!.description).toBe(
      "Rounding biscuits",
    );
  });

  it("requires the rounding line after the items", () => {
    const { receipt: r, warnings } = parseReceiptText(
      "SHOP\nCash rounding -0.02\n1 x Synthetic product 10.00\nTotal 9.98",
    );
    expect(r.receiptTotalCents).toBe(998);
    expect(warnings.join(" ")).toMatch(/before the items/);
  });
});
