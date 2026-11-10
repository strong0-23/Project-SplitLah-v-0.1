/**
 * Extra correction actions (owner-confirmed definition, 11 Nov 2026). Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { countCorrections, countSilent } from "./corrections";
import { evaluate, type Check, type Expected } from "./model";
import { rework } from "./rework-parser";

const fail = (key: string, silent = false): Check => ({ key, status: "fail", silent });
const pass = (key: string): Check => ({ key, status: "pass" });
const unknown = (key: string): Check => ({ key, status: "unknown" });

describe("countCorrections", () => {
  it("counts one action per missing product, extra row, wrong quantity and wrong amount", () => {
    const c = countCorrections([
      // matched product with wrong quantity and wrong amount: 2 actions (5 in all below)
      pass("item:tea#1:present"),
      fail("item:tea#1:quantity"),
      fail("item:tea#1:lineTotalCents"),
      // missing product: 1 action (its quantity and amount are entered with it)
      fail("item:cake#1:present"),
      fail("item:cake#1:quantity"),
      fail("item:cake#1:lineTotalCents"),
      // extra rows: 1 action each; the aggregate count is not an action
      fail("extra:3:napkin"),
      fail("extra:4:straw"),
      fail("extraItemCount"),
    ]);
    expect(c).toEqual({
      total: 5,
      missing: 1,
      extra: 2,
      quantity: 1,
      amount: 1,
      charges: 0,
      printedTotal: 0,
    });
  });

  it("counts each wrong charge field and the printed total, never the calculated total", () => {
    const c = countCorrections([
      fail("discountCents"),
      fail("serviceChargeCents"),
      fail("gstCents"),
      fail("gstInclusive"),
      fail("printedPayableTotalCents"),
      fail("computedPayableTotalCents"),
    ]);
    expect(c.charges).toBe(4);
    expect(c.printedTotal).toBe(1);
    expect(c.total).toBe(5);
  });

  it("never counts unknown or passing fields", () => {
    const c = countCorrections([
      unknown("item:tea#1:quantity"),
      unknown("gstCents"),
      unknown("printedPayableTotalCents"),
      unknown("extraItemCount (incomplete reference)"),
      pass("discountCents"),
      unknown("item:tea#1:unitPriceCents (reference only)"),
    ]);
    expect(c.total).toBe(0);
  });

  it("matches duplicate products by occurrence", () => {
    const c = countCorrections([
      pass("item:tea#1:present"),
      fail("item:tea#1:lineTotalCents"),
      fail("item:tea#2:present"),
      fail("item:tea#2:lineTotalCents"),
    ]);
    expect(c).toMatchObject({ total: 2, missing: 1, amount: 1 });
  });

  it("counts silent errors as evaluate marks them", () => {
    expect(countSilent([fail("gstCents", true), fail("discountCents"), pass("gstInclusive")])).toBe(
      1,
    );
  });
});

describe("countCorrections with the harness's own matching (evaluate, unchanged)", () => {
  const expected: Expected = {
    items: [
      { description: "PLAIN WAFFLE", quantity: 2, lineTotalCents: 800 },
      { description: "HOT COCOA", quantity: 1, lineTotalCents: 450 },
    ],
    itemsComplete: true,
    discountCents: 0,
    serviceChargeCents: 0,
    gstCents: 112,
    gstInclusive: false,
    payableTotalCents: 1362,
  };
  const score = (text: string) =>
    countCorrections(evaluate(expected, rework.parse(text).receipt, rework));

  it("a correct reading needs no corrections", () => {
    const text = [
      "Item           Qty  Amount",
      "PLAIN WAFFLE    2    8.00",
      "HOT COCOA       1    4.50",
      "Subtotal            12.50",
      "GST 9%               1.12",
      "Total               13.62",
    ].join("\n");
    expect(score(text).total).toBe(0);
  });

  it("a misread product name is one missing product plus one extra row", () => {
    const text = [
      "Item           Qty  Amount",
      "PLAIN WAFFLE    2    8.00",
      "H0T C0C0A       1    4.50",
      "Subtotal            12.50",
      "GST 9%               1.12",
      "Total               13.62",
    ].join("\n");
    expect(score(text)).toMatchObject({ missing: 1, extra: 1, total: 2 });
  });
});
