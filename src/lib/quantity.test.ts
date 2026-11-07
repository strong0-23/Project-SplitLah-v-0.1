import { describe, expect, it } from "vitest";
import { formatQuantity, isValidQuantity, itemQuantity, parseQuantity, quantityNumber, validatePriceRelationship } from "./quantity";
import type { ReceiptItem } from "./types";

const item = (fields: Partial<ReceiptItem> = {}): ReceiptItem => ({ id: "a", description: "Bulk fruit", quantity: 1, quantityExact: { numerator: 3, denominator: 4 }, unitPriceCents: 200, lineTotalCents: 150, ...fields });

describe("exact quantities", () => {
  it("preserves decimals and fractions without binary floating point", () => {
    expect(parseQuantity("0.125")).toEqual({ numerator: 1, denominator: 8 });
    expect(parseQuantity("2/6")).toEqual({ numerator: 1, denominator: 3 });
    expect(parseQuantity("-.25")).toEqual({ numerator: -1, denominator: 4 });
    expect(parseQuantity("9998.999999")).toEqual({ numerator: 9998999999, denominator: 1000000 });
    expect(quantityNumber(parseQuantity("3/4")!)).toBe(.75);
  });
  it("rejects unsafe, unbounded, scientific or malformed values", () => {
    for (const text of ["10000", "-10000", "1/0", "1/1000001", "0.0000001", "1e3", "1/2/3", "NaN", "", "999999999999999999999/999999999999999999999"])
      expect(parseQuantity(text)).toBeNull();
    expect(isValidQuantity({ numerator: 1, denominator: -1 })).toBe(false);
  });
  it("formats terminating decimals or exact recurring fractions", () => {
    expect(formatQuantity({ numerator: -1, denominator: 4 })).toBe("-0.25");
    expect(formatQuantity({ numerator: 2, denominator: 6 })).toBe("1/3");
    expect(formatQuantity({ numerator: 0, denominator: 100 })).toBe("0");
    expect(formatQuantity({ numerator: 7, denominator: 1 })).toBe("7");
  });
  it("does not replace an explicitly unknown quantity with the compatibility 1", () => {
    expect(itemQuantity(item({ quantity: 1, quantityExact: null }))).toBeNull();
    expect(itemQuantity(item({ quantity: 2, quantityExact: undefined }))).toEqual({ numerator: 2, denominator: 1 });
    expect(itemQuantity(item({ quantityExact: undefined, evidence: { quantity: { origin: "defaulted", needsReview: true, reasons: [], sources: [] } } }))).toBeNull();
  });
});

describe("existing price relationships", () => {
  it("compares exact fractional multiplication rounded half up once", () => {
    expect(validatePriceRelationship(item())).toEqual([]);
    expect(validatePriceRelationship(item({ quantityExact: { numerator: 1, denominator: 2 }, unitPriceCents: 5, lineTotalCents: 3 }))).toEqual([]);
    expect(validatePriceRelationship(item({ quantityExact: { numerator: 1, denominator: 2 }, unitPriceCents: 5, lineTotalCents: 2 }))).toHaveLength(1);
    expect(validatePriceRelationship(item({ quantityExact: { numerator: 1, denominator: 3 }, unitPriceCents: 100, lineTotalCents: 33 }))).toEqual([]);
  });
  it("converts documented compatible quantity and price-basis units", () => {
    expect(validatePriceRelationship(item({ quantityExact: { numerator: 250, denominator: 1 }, unitOfMeasure: "g", priceBasis: { quantity: { numerator: 1, denominator: 1 }, unit: "kg" }, unitPriceCents: 600, lineTotalCents: 150 }))).toEqual([]);
    expect(validatePriceRelationship(item({ quantityExact: { numerator: 3, denominator: 4 }, unitOfMeasure: "kg", priceBasis: { quantity: { numerator: 100, denominator: 1 }, unit: "g" }, unitPriceCents: 20, lineTotalCents: 150 }))).toEqual([]);
    expect(validatePriceRelationship(item({ unitOfMeasure: "kg", priceBasis: { quantity: { numerator: 1, denominator: 1 }, unit: "ml" } }))).toHaveLength(1);
    expect(validatePriceRelationship(item({ priceBasis: { quantity: { numerator: 1, denominator: 1 }, unit: "kg" } }))).toHaveLength(1);
  });
  it("preserves signed return amounts and explicitly identified adjustments", () => {
    expect(validatePriceRelationship(item({ rowKind: "return", lineTotalCents: -150 }))).toEqual([]);
    expect(validatePriceRelationship(item({ rowKind: "return", quantityExact: { numerator: -3, denominator: 4 }, lineTotalCents: -150 }))).toEqual([]);
    expect(validatePriceRelationship(item({ rowKind: "adjustment", pricingContext: { discounts: "none", tax: "compatible", adjustment: "explicit" }, lineTotalCents: -5 }))).toEqual([]);
  });
  it("does not clear unresolved financial context merely because arithmetic agrees", () => {
    for (const pricingContext of [
      { discounts: "unresolved", tax: "compatible", adjustment: "none" },
      { discounts: "none", tax: "unresolved", adjustment: "none" },
      { discounts: "none", tax: "compatible", adjustment: "unresolved" },
    ] as const) expect(validatePriceRelationship(item({ pricingContext }))).toHaveLength(1);
    expect(validatePriceRelationship(item({ unitPriceCents: null }))).toEqual([]);
    expect(validatePriceRelationship(item({ quantityExact: null }))).toEqual([]);
  });
  it("validates explicitly compatible discounted prices without waiving a mismatch", () => {
    const pricingContext = { discounts: "included", tax: "compatible", adjustment: "none" } as const;
    expect(validatePriceRelationship(item({ pricingContext }))).toEqual([]);
    expect(validatePriceRelationship(item({ pricingContext, lineTotalCents: 149 }))).toEqual([
      "Quantity × unit price does not match the full line amount (rounded once, half up to cents).",
    ]);
    expect(validatePriceRelationship(item({ pricingContext: { ...pricingContext, discounts: "unresolved" } }))).toHaveLength(1);
  });
  it("flags discrepancies without mutating any evidence or value", () => {
    const value = item({ lineTotalCents: 149 });
    const before = structuredClone(value);
    expect(validatePriceRelationship(value)).toHaveLength(1);
    expect(value).toEqual(before);
  });
});
