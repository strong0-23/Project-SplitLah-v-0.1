/**
 * Batch 2a: the parser-v2 parsing rules that Batch 1b had not ported (branch `parser-v2`, commit
 * a80f7e3). All synthetic text with invented product names. Each `describe` names the parser-v2
 * rule and, where there is one, the parser-v2 test it comes from. See
 * docs/reports/2026-11-parser-v2-port.md for the full inventory.
 */
import { describe, expect, it } from "vitest";
import { computeTotals } from "../bill";
import { parseReceiptText, scoreParse } from "./parse";

const parse = (t: string) => parseReceiptText(t).receipt;
const warn = (t: string) => parseReceiptText(t).warnings.join(" ");
const row = (t: string) => {
  const i = parse(t).items[0]!;
  return [i.description, i.quantity, i.lineTotalCents, i.flagged];
};

describe("an amount after @ is a unit price, never the line total (trailing-quantity.batch1d)", () => {
  it.each([
    ["EXAMPLE CAFE\nCOFFEE 2 @ 3.50\nTotal 7.00", "COFFEE", 2],
    ["EXAMPLE CAFE\nCOFFEE @ $3.50", "COFFEE", 1],
    ["EXAMPLE CAFE\n2 x COFFEE @ $3.50", "COFFEE", 2],
  ] as const)("keeps the line total unknown and flags the row: %s", (text, desc, qty) => {
    expect(row(text)).toEqual([desc, qty, null, true]);
    expect(parse(text).uncertainFields).toContain("items");
    expect(warn(text)).toMatch(/unit price \(@ 3\.50\) but no line total/);
  });

  it("does the same for a detail row under a name row and for weighed goods", () => {
    const t =
      "EXAMPLE MART\n1 x BREAD 2.00\nOAT DRINK 1L\n2 @ 8.95\nBANANA 0.512kg @ 3.98/kg\nTotal 21.94";
    expect(
      parse(t).items.map((i) => [i.description, i.quantity, i.lineTotalCents, i.flagged]),
    ).toEqual([
      ["BREAD", 1, 200, false],
      ["OAT DRINK 1L", 2, null, true],
      ["BANANA 0.512kg", 1, null, true],
    ]);
  });

  it("still reads the line total printed after the unit price", () => {
    expect(row("EXAMPLE MART\nOAT DRINK 1L\n2 @ 8.95  17.90\nTotal 17.90")).toEqual([
      "OAT DRINK 1L",
      2,
      1790,
      false,
    ]);
    expect(row("EXAMPLE MART\nBANANA 0.512kg @ 3.98/kg 2.04\nTotal 2.04")).toEqual([
      "BANANA 0.512kg",
      1,
      204,
      false,
    ]);
  });

  it("reconciles once the user enters the missing line total", () => {
    const r = parse("EXAMPLE CAFE\n1 x MUFFIN 2.00\nCOFFEE 2 @ 3.50\nTotal 9.00");
    r.items[1]!.lineTotalCents = 700;
    const t = computeTotals(r);
    expect(t.ok && t.value.mismatchCents).toBe(0);
  });

  it("flags a lone amount after 'N x' (unit price or line total?) but keeps it", () => {
    expect(row("EXAMPLE CAFE\nCOFFEE 2 x 3.50\nTotal 7.00")).toEqual(["COFFEE", 2, 350, true]);
  });
});

describe("a decimal or fractional number next to a name stays in the name, flagged (trailing-quantity.batch1d, D7)", () => {
  it.each([
    "VERSION 2.5",
    "LOOSE TEA 1/2",
    "SPARKLING WATER 1.5",
    "0.5 x LOOSE TEA",
    "1/2 ROAST DUCK",
  ])("unheaded: %s", (name) => {
    expect(row(`EXAMPLE MERCHANT\n${name} 8.00\nTotal 8.00`)).toEqual([name, 1, 800, true]);
  });

  it.each(["LOOSE TEA 1/2", "LOOSE TEA 0.5"])(
    "under a Qty heading (no fractional quantities): %s",
    (name) => {
      expect(row(`EXAMPLE MERCHANT\nDescription Qty Amount\n${name} 4.00\nTotal 4.00`)).toEqual([
        name,
        1,
        400,
        true,
      ]);
    },
  );

  it("does not flag package sizes or identifiers", () => {
    expect(row("EXAMPLE MERCHANT\nSPARKLING WATER 1.5L 2.00\nTotal 2.00")).toEqual([
      "SPARKLING WATER 1.5L",
      1,
      200,
      false,
    ]);
    expect(row("EXAMPLE MERCHANT\nNoodles No 8 3.50\nTotal 3.50")[3]).toBe(false);
  });
});

describe("a total printed with a minus sign is not used (parser-interpretation: conflicting printed totals)", () => {
  it.each(["Total 4.00-F", "Total -4.00"])("%s", (line) => {
    const t = `EXAMPLE MERCHANT\n1 x SOAP 4.00\n${line}\nVisa 4.00`;
    const r = parse(t);
    expect(r.receiptTotalCents).toBeNull();
    expect(r.uncertainFields).toContain("total");
    expect(warn(t)).toMatch(/total is printed with a minus sign/);
  });
});

describe("unreadable or unsupported rounding rows are reported, never applied (receipt-rounding)", () => {
  const T = (rows: string) =>
    `SYNTHETIC SHOP\n1 x Synthetic product 10.00\nTotal 10.00\n${rows}\nTotal Due 9.98`;

  it.each(["Rounding", "Cash rounding unreadable", "Bill rounding ??"])("%s", (rows) => {
    const r = parse(T(rows));
    expect(r.uncertainFields).toContain("total");
    expect(warn(T(rows))).toMatch(/has no readable amount, so no rounding was applied/);
    expect(warn(T(rows))).not.toMatch(/rounded the payable amount/);
  });

  it("still reads a rounding label with its amount on the next line", () => {
    const t = T("Rounding\n-0.02");
    expect(parse(t).receiptTotalCents).toBe(1000);
    expect(warn(t)).toMatch(/rounded the payable amount by -0\.02/);
    expect(warn(t)).not.toMatch(/no readable amount/);
  });

  it("does not apply a rounding row when no total is printed", () => {
    const t = "SYNTHETIC SHOP\n1 x Synthetic product 10.00\nCash rounding -0.02";
    expect(parse(t).receiptTotalCents).toBeNull();
    expect(warn(t)).toMatch(/rounding line was printed but no total was found/);
  });

  it("does not report a product with rounding words as an unreadable rounding row", () => {
    const t = "SYNTHETIC SHOP\n1 x ROUND CRACKERS 3.00\nROUNDING BISCUITS\nTotal 3.00";
    expect(warn(t)).not.toMatch(/rounding line/i);
    expect(parse(t).receiptTotalCents).toBe(300);
  });
});

describe("a minus amount with no label is not known to be a discount (parser.test: signed rows)", () => {
  it("is not deducted after a total or subtotal", () => {
    const t = "EXAMPLE SHOP\n1 x SOAP 4.00\nSubtotal 4.00\n-1.00\nTotal 3.00";
    const r = parse(t);
    expect(r.discountCents).toBe(0);
    expect(r.uncertainFields).toContain("discount");
    expect(warn(t)).toMatch(/minus amount with no label \(-1\.00\) was not deducted/);
  });

  it("is not deducted under an item whose price is unknown", () => {
    const r = parse("EXAMPLE SHOP\nDescription Qty Amount\nUNPRICED PRODUCT\n-4.20\nTotal 8.00");
    expect(r.discountCents).toBe(0);
    expect(r.items.every((i) => i.lineTotalCents === null)).toBe(true);
    expect(r.uncertainFields).toContain("discount");
  });

  it("under a priced item still reduces it (D2), but flagged for a check", () => {
    const t = "EXAMPLE SHOP\n1 x SOAP 4.00\n-1.00\nTotal 3.00";
    const r = parse(t);
    expect(r.items[0]).toMatchObject({ lineTotalCents: 300, flagged: true });
    expect(r.discountCents).toBe(0);
    expect(r.uncertainFields).toContain("discount");
    expect(warn(t)).toMatch(/was taken off the item above it/);
  });

  it("labelled discounts are unchanged", () => {
    expect(
      parse("EXAMPLE SHOP\n1 x SOAP 4.00\nSubtotal 4.00\nDiscount 1.00-\nTotal 3.00").discountCents,
    ).toBe(100);
  });
});

describe("discount labels: member discount and discount codes (parser-v2 discount grammar)", () => {
  it.each([
    "Member Discount 1.00-",
    "Discount: ABC-1 1.00-",
    "Voucher #A12 1.00-",
    "Coupon - X2 -1.00",
  ])("%s is a bill discount in the summary", (line) => {
    const r = parse(`EXAMPLE SHOP\n1 x SOAP 4.00\nSubtotal 4.00\n${line}\nTotal 3.00`);
    expect(r.discountCents).toBe(100);
    expect(r.items).toHaveLength(1);
  });

  it("a code without a digit does not turn a product into a discount", () => {
    const r = parse("EXAMPLE SHOP\nPROMO: SET A 5.00\nTotal 5.00");
    expect(r.items.map((i) => [i.description, i.lineTotalCents])).toEqual([["PROMO SET A", 500]]);
    expect(r.discountCents).toBe(0);
  });
});

describe("unit price and line amount on different tax bases: no quantity is worked out (parser-interpretation)", () => {
  it.each([
    "Description Unit (incl GST) Qty Amount (excl GST)\nCOFFEE 3.00 ? 6.00",
    "Description Unit($) Qty Amount\nUnit prices exclude GST\nLine amount includes GST\nCOFFEE 3.00 ? 6.00",
    "Description Unit (excl GST) Amount (incl GST)\nCOFFEE 3.00 6.00",
  ])("%s", (body) => {
    const t = `EXAMPLE SHOP\n${body}\nTotal 6.00`;
    expect(row(t)).toEqual(["COFFEE", 1, 600, true]);
    expect(parse(t).uncertainFields).toContain("items");
    expect(warn(t)).toMatch(/different tax bases/);
  });

  it("an explicit quantity column is still read, flagged", () => {
    expect(
      row(
        "EXAMPLE SHOP\nDescription Unit (incl GST) Qty Amount (excl GST)\nCOFFEE 3.00 2 6.00\nTotal 6.00",
      ),
    ).toEqual(["COFFEE", 2, 600, true]);
  });

  it("without mixed tax bases the quantity is still auto-filled (flagged), as before", () => {
    expect(
      row("EXAMPLE SHOP\nDescription Unit($) Qty Amount\nCOFFEE 3.00 ? 6.00\nTotal 6.00"),
    ).toEqual(["COFFEE", 2, 600, true]);
  });
});

describe("scoreParse: a reading with no items never wins (parser-v2 scoreParse)", () => {
  it("scores a footer-only reading below one whose items still need fixing", () => {
    const footerOnly = parse("EXAMPLE SHOP\nTotal 4.00\nVisa 4.00");
    const damaged = parse("EXAMPLE SHOP\nDescription Qty Amount\nSOAP\n| 4.20 2\nTotal 4.00");
    expect(scoreParse(footerOnly)).toBe(Number.NEGATIVE_INFINITY);
    expect(scoreParse(damaged)).toBeGreaterThan(scoreParse(footerOnly));
  });
});
