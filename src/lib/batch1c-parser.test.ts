import { describe, expect, it } from "vitest";
import { parseReceiptText } from "./parser";
import { applyImplicitQuantityDefaults, applyUserQuantityOne, confirmQuantityDefaults, eligibleQuantityDefaults } from "./quantity-defaults";

describe("numeric product identity and tax margin evidence", () => {
  it.each(["100 PLUS", "42 VITAMIN", "7 NOODLES"])("preserves unsupported numeric prefixes: %s", name => {
    const r = parseReceiptText(`SHOP\n${name} 3.50\nTotal 3.50`).receipt;
    expect(r.items[0]).toMatchObject({ description: name, quantityExact: null, flagged: true });
  });
  it("preserves numeric prefixes on damaged split lines without inventing quantity", () => {
    const r = parseReceiptText("SHOP\n100 PLUS\n3 4.00 V F\nTotal 4.00").receipt;
    expect(r.items[0]).toMatchObject({ description: "100 PLUS", quantityExact: null, lineTotalCents: null });
  });
  it("uses explicit multiplication or a quantity heading while keeping numeric product names", () => {
    expect(parseReceiptText("SHOP\n2 x 100 PLUS 7.00").receipt.items[0]).toMatchObject({ description: "100 PLUS", quantity: 2 });
    expect(parseReceiptText("SHOP\nProduct Qty Total\n100 PLUS 2 7.00").receipt.items[0]).toMatchObject({ description: "100 PLUS", quantity: 2 });
  });
  it("retains labelled tax plus one isolated margin token for specific review", () => {
    const r = parseReceiptText("SHOP\nProduct Qty Total\nSOAP 1 26.00\nSales Amount 23.66\nTotal tax X $2.34\nTotal 26.00").receipt;
    expect(r.gstAmountCents).toBe(234);
    expect(r.gstInclusive).toBe(true);
    expect(r.evidence!.gst).toMatchObject({ origin: "observed", needsReview: true });
    expect(r.evidence!.gst!.sources[0]!.text).toBe("Total tax X $2.34");
    expect(parseReceiptText("SHOP\nProduct Qty Total\nGST FREE COLA 1 4.00\nTotal 4.00").receipt.items[0]!.description).toBe("GST FREE COLA");
  });
});

const implicit = "SHOP\nDescription         Amount\nCOFFEE              3.00\nMUFFIN              2.00\nTotal               5.00";
describe("positive implicit-layout defaults and explicit user entry", () => {
  it("offers flagged defaults only with complete aligned two-column support", () => {
    const r = applyImplicitQuantityDefaults(parseReceiptText(implicit).receipt, implicit);
    expect(eligibleQuantityDefaults(r)).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ quantity: 1, quantityExact: { numerator: 1, denominator: 1 }, evidence: { quantity: { origin: "defaulted", needsReview: true } } });
    const next = confirmQuantityDefaults(r, r.items.map(item => item.id));
    expect(next.items[0]!.evidence!.quantity).toMatchObject({ origin: "user-confirmed", previousOrigin: "defaulted", needsReview: false });
    expect(next.items[0]!.evidence!.quantity!.sources.length).toBeGreaterThan(r.items[0]!.evidence!.quantity!.sources.length);
  });
  it.each([
    implicit.replace("Description         Amount", "Description Qty     Amount"),
    implicit.replace("Description         Amount", "Description Q       Amount"),
    implicit.replace("COFFEE              3.00", "COFFEE\n| broken 3 00"),
    implicit.replace("COFFEE              3.00", "COFFEE 2            3.00"),
    implicit.replace("COFFEE", "100 PLUS"),
    implicit.replace("COFFEE", "LOOSE TEA 250g"),
    implicit.replaceAll(/ {2,}/g, " "),
    implicit.replace("MUFFIN              2.00", "MUFFIN              ?.00"),
  ])("keeps unsupported/damaged/mixed/measured layouts unknown", text => {
    const r = applyImplicitQuantityDefaults(parseReceiptText(text).receipt, text);
    expect(eligibleQuantityDefaults(r)).toHaveLength(0);
  });
  it("explicit selected count entry confirms only selected unknown quantities", () => {
    const r = parseReceiptText("SHOP\nCOFFEE 3.00\nMUFFIN 2.00\nTotal 5.00").receipt;
    const n = applyUserQuantityOne(r, [r.items[0]!.id]);
    expect(n.items[0]!.evidence!.quantity).toMatchObject({ origin: "user-confirmed", previousOrigin: "unknown" });
    expect(n.items[1]!.quantityExact).toBeNull();
  });
});
