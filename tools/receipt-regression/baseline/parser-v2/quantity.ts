import { isSafeSignedCents, MAX_QUANTITY } from "./money";
import type { RationalQuantity, ReceiptItem } from "./types";

const MAX_DENOMINATOR = 1_000_000;
const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);

/** Canonical exact decimal/fraction. Six decimal places and |quantity| <= 9999. */
export function parseQuantity(input: string): RationalQuantity | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  const fraction = /^([+-]?\d+)\s*\/\s*(\d+)$/.exec(text);
  let numerator: number;
  let denominator: number;
  if (fraction) {
    numerator = Number(fraction[1]);
    denominator = Number(fraction[2]);
  } else {
    const decimal = /^([+-]?)(\d+)(?:\.(\d{1,6}))?$/.exec(text) ?? /^([+-]?)()\.(\d{1,6})$/.exec(text);
    if (!decimal) return null;
    denominator = 10 ** (decimal[3]?.length ?? 0);
    numerator = Number(decimal[2] || "0") * denominator + Number(decimal[3] || "0");
    if (decimal[1] === "-") numerator = -numerator;
  }
  const value = { numerator, denominator };
  if (!isValidQuantity(value)) return null;
  const factor = gcd(Math.abs(numerator), denominator);
  return { numerator: numerator / factor, denominator: denominator / factor };
}

export function isValidQuantity(q: unknown): q is RationalQuantity {
  if (!q || typeof q !== "object") return false;
  const value = q as RationalQuantity;
  return Number.isSafeInteger(value.numerator) && Number.isSafeInteger(value.denominator) &&
    value.denominator > 0 && value.denominator <= MAX_DENOMINATOR &&
    BigInt(Math.abs(value.numerator)) <= BigInt(MAX_QUANTITY) * BigInt(value.denominator);
}

export function quantityNumber(q: RationalQuantity): number {
  return q.numerator / q.denominator;
}

/** Terminating decimals stay familiar; recurring fractions stay exact. */
export function formatQuantity(q: RationalQuantity): string {
  if (!isValidQuantity(q)) return "";
  const factor = gcd(Math.abs(q.numerator), q.denominator);
  const numerator = q.numerator / factor;
  let denominator = q.denominator / factor;
  const reducedDenominator = denominator;
  while (denominator % 2 === 0) denominator /= 2;
  while (denominator % 5 === 0) denominator /= 5;
  if (denominator !== 1) return `${numerator}/${reducedDenominator}`;
  const sign = numerator < 0 ? "-" : "";
  const n = BigInt(Math.abs(numerator));
  const d = BigInt(reducedDenominator);
  const whole = n / d;
  let remainder = n % d;
  let decimals = "";
  while (remainder) {
    remainder *= 10n;
    decimals += String(remainder / d);
    remainder %= d;
  }
  return `${sign}${whole}${decimals ? `.${decimals}` : ""}`;
}

/** Explicit unknown takes precedence over the legacy display placeholder. */
export function itemQuantity(item: ReceiptItem): RationalQuantity | null {
  if (item.quantityExact !== undefined) return isValidQuantity(item.quantityExact) ? item.quantityExact : null;
  if (item.evidence?.quantity && ["unknown", "defaulted"].includes(item.evidence.quantity.origin)) return null;
  return Number.isSafeInteger(item.quantity) && Math.abs(item.quantity) <= MAX_QUANTITY
    ? { numerator: item.quantity, denominator: 1 } : null;
}

const units: Record<string, { family: string; scale: number }> = {
  g: { family: "mass", scale: 1 }, gram: { family: "mass", scale: 1 }, grams: { family: "mass", scale: 1 },
  kg: { family: "mass", scale: 1000 }, kilogram: { family: "mass", scale: 1000 }, kilograms: { family: "mass", scale: 1000 },
  ml: { family: "volume", scale: 1 }, l: { family: "volume", scale: 1000 }, litre: { family: "volume", scale: 1000 }, liter: { family: "volume", scale: 1000 },
  count: { family: "count", scale: 1 }, ea: { family: "count", scale: 1 }, each: { family: "count", scale: 1 }, unit: { family: "count", scale: 1 }, units: { family: "count", scale: 1 }, piece: { family: "count", scale: 1 }, pieces: { family: "count", scale: 1 }, pcs: { family: "count", scale: 1 },
};

/** Existing field validation only: never changes prices or fills quantities. */
export function validatePriceRelationship(item: ReceiptItem): string[] {
  const quantity = itemQuantity(item);
  if (item.unitPriceCents === undefined || item.unitPriceCents === null || item.lineTotalCents === null || quantity === null) return [];
  if (!isSafeSignedCents(item.unitPriceCents) || !isSafeSignedCents(item.lineTotalCents)) return ["Unit price or line amount is invalid."];
  if (item.rowKind === "adjustment" && item.pricingContext?.adjustment === "explicit") return [];
  const context = item.pricingContext;
  // "included" means both observed prices use the SAME discounted basis. A
  // gross unit price with a net line amount must remain "unresolved" instead.
  // Confirming that basis never waives the exact numerical relationship below.
  if (context?.discounts === "unresolved") return ["Confirm the discount pricing basis before checking quantity against the line amount."];
  if (context?.tax === "unresolved") return ["Confirm whether unit price and line amount use the same tax basis."];
  if (context?.adjustment === "unresolved" || context?.adjustment === "explicit") return ["Confirm the adjustment pricing basis before checking quantity against the line amount."];
  const basis = item.priceBasis?.quantity ?? { numerator: 1, denominator: 1 };
  if (!isValidQuantity(basis) || basis.numerator <= 0) return ["Price basis must be a positive exact quantity."];
  let fromScale = 1;
  let toScale = 1;
  if (item.priceBasis) {
    const quantityUnit = item.unitOfMeasure?.trim().toLowerCase();
    const priceUnit = item.priceBasis.unit.trim().toLowerCase();
    if (!quantityUnit || !priceUnit) return ["Confirm the quantity and unit-price units before checking their relationship."];
    if (quantityUnit !== priceUnit) {
      const from = units[quantityUnit];
      const to = units[priceUnit];
      if (!from || !to || from.family !== to.family) return ["Quantity and unit-price units are incompatible or unrecognised."];
      fromScale = from.scale;
      toScale = to.scale;
    }
  }
  let numerator = BigInt(item.unitPriceCents) * BigInt(quantity.numerator) * BigInt(basis.denominator) * BigInt(fromScale);
  const denominator = BigInt(quantity.denominator) * BigInt(basis.numerator) * BigInt(toScale);
  if (item.rowKind === "return") numerator = -abs(numerator);
  const expected = (abs(numerator) * 2n + denominator) / (2n * denominator) * (numerator < 0n ? -1n : 1n);
  return expected === BigInt(item.lineTotalCents) ? [] : ["Quantity × unit price does not match the full line amount (rounded once, half up to cents)."];
}

const abs = (value: bigint): bigint => value < 0n ? -value : value;
