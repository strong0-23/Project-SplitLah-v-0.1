import { describe, expect, it } from "vitest";
import { itemRegion, type OcrWord } from "./ocr-regions";
const word = (text: string, x0: number, y0: number, x1: number, y1: number): OcrWord => ({ text, confidence: 90, bbox: { x0, y0, x1, y1 } });
const words = [word("DENTAL", 10, 50, 70, 70), word("PICKS", 80, 50, 120, 70), word("50M", 130, 50, 160, 70), word("2", 190, 90, 200, 110), word("5.20", 240, 90, 280, 110)];
describe("item row geometry", () => {
  it("finds the named row including its numeric columns without prices as search keys", () => {
    const r = itemRegion(words, "DENTAL PICKS 50M", 400, 500)!;
    expect(r.left).toBeLessThanOrEqual(10 / 400);
    expect(r.right).toBeGreaterThan(280 / 400);
    expect(r.top).toBeLessThan(50 / 500);
    expect(r.bottom).toBeGreaterThanOrEqual(110 / 500);
  });
  it("rejects unknown, duplicate and invalid descriptor geometry", () => {
    expect(itemRegion(words, "MISSING PRODUCT", 400, 500)).toBeNull();
    expect(itemRegion([...words, ...words], "DENTAL PICKS 50M", 400, 500)).toBeNull();
    expect(itemRegion([word("DENTAL", -1, 50, 70, 70), ...words.slice(1)], "DENTAL PICKS 50M", 400, 500)).toBeNull();
    expect(itemRegion(words, "Grand Total", 400, 500)).toBeNull();
  });
  it("retains full width when the price has not been located", () => {
    expect(itemRegion(words.slice(0, 2), "DENTAL PICKS", 400, 500)!.right).toBe(1);
  });
  it("accounts for the observed row slope rather than clipping higher right-hand columns", () => {
    const r = itemRegion([word("EVENING", 20, 120, 160, 160), word("FILM", 180, 100, 300, 140), word("ADULT", 320, 80, 460, 120), word("12.00", 700, 40, 780, 80)], "EVENING FILM ADULT", 900, 1000)!;
    expect(r.top * 1000).toBeLessThan(40);
    expect(r.right * 900).toBeGreaterThanOrEqual(780);
  });
});
