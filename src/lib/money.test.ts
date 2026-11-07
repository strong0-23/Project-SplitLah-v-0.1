import { describe, expect, it } from "vitest";
import { applyRate, centsToInput, includedTax, isSafeSignedCents, MAX_CENTS, parseMoney, parseSignedMoney } from "./money";

describe("deliberate signed money", () => {
  it("keeps unsigned parsing separate from signed return entry", () => {
    expect(parseMoney("-1.25")).toBeNull();
    expect(parseSignedMoney("-1.25")).toBe(-125);
    expect(parseSignedMoney("- $0.05")).toBe(-5);
    expect(parseSignedMoney("+1.25")).toBe(125);
    expect(parseSignedMoney("--1.25")).toBeNull();
    expect(parseSignedMoney("(1.25)")).toBeNull();
  });
  it("formats negative cents correctly, including less than one dollar", () => {
    expect(centsToInput(-5)).toBe("-0.05");
    expect(centsToInput(-105)).toBe("-1.05");
    expect(centsToInput(105)).toBe("1.05");
    expect(centsToInput(null)).toBe("");
  });
  it("bounds signed integer cents and uses symmetric half-up rounding", () => {
    expect(isSafeSignedCents(-MAX_CENTS)).toBe(true);
    expect(isSafeSignedCents(-MAX_CENTS - 1)).toBe(false);
    expect(isSafeSignedCents(-.5)).toBe(false);
    expect(applyRate(-5, 1000)).toBe(-1);
    expect(includedTax(-1000, 900)).toBe(-83);
  });
});
