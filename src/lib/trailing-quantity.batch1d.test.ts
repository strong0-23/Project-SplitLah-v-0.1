import { describe, expect, it } from "vitest";
import { parseReceiptText, splitItemLabel } from "./parser";
import { parseOcrResult } from "./receipt-reading";
import { scoreOcrText } from "./scan-score";
import { assessReceipt } from "./receipt-status";
import type { OcrResult } from "./ocr";

const text = (body: string) => `EXAMPLE MERCHANT\n${body}`;
const direct = (body: string) => parseReceiptText(text(body)).receipt;
const coordinated = (body: string) => {
  const raw = text(body);
  const ocr: OcrResult = { text: raw, rotation: 0, crop: null, passes: 1, selectedAttempt: 0,
    attempts: [{ text: raw, preprocessing: "flattened", pageSegmentation: "6", ...scoreOcrText(raw) }] };
  return parseOcrResult(ocr).receipt;
};

describe("Batch 1d: trailing numbers require quantity evidence", () => {
  for (const [path, parse] of [["parseReceiptText", direct], ["parseOcrResult", coordinated]] as const) {
    it.each(["VITAMIN B 12", "PAINT SHADE 42", "VERSION 2.5", "MODEL 12", "PACK 12", "LOOSE TEA 1/2", "RICE 250g", "100 PLUS", "7 NOODLES"])(`${path} preserves an unheaded numeric identity: %s`, name => {
      const receipt = parse(`${name} 8.00\nTotal 8.00`);
      expect(receipt.items).toHaveLength(1);
      const item = receipt.items[0]!;
      expect(item).toMatchObject({ description: name, quantityExact: null, lineTotalCents: 800, flagged: true });
      expect(item.evidence?.quantity).toMatchObject({ origin: "unknown", needsReview: true });
      expect(item.evidence?.description?.sources[0]?.text).toBe(`${name} 8.00`);
      expect(assessReceipt(receipt).reasons.some(reason => reason.path === "items[0].quantity")).toBe(true);
      if (path === "parseOcrResult") expect(item.evidence?.quantity?.sources[0]).toMatchObject({ engine: "tesseract", attemptIndex: 0, lineIndices: [1] });
    });
  }

  it("does not make the helper's default mode an implicit quantity column", () => {
    expect(splitItemLabel("VITAMIN B 12")).toMatchObject({ desc: "VITAMIN B 12", quantityExact: null, quantityObserved: false, qtyUncertain: true });
  });

  it.each([
    ["2 x VITAMIN B 12 16.00", "VITAMIN B 12", 2, 1, 1600],
    ["0.5 x LOOSE TEA 4.00", "LOOSE TEA", 1, 2, 400],
    ["Description Qty Amount\nVITAMIN B 12 2 16.00", "VITAMIN B 12", 2, 1, 1600],
    ["Qty Description Amount\n2 VITAMIN B 12 16.00", "VITAMIN B 12", 2, 1, 1600],
    ["Description Qty Amount\nLOOSE TEA 1/2 4.00", "LOOSE TEA", 1, 2, 400],
    ["Description Qty (kg) Amount\nLOOSE TEA 0.125 1.00", "LOOSE TEA", 1, 8, 100],
    ["Description Qty Amount\nMILK 500ml 2 6.00", "MILK 500ml", 2, 1, 600],
    ["Description Qty Amount\nBATTERIES 4-pack 2 8.00", "BATTERIES 4-pack", 2, 1, 800],
  ] as const)("preserves explicit multiplication and supported quantity columns: %s", (body, name, numerator, denominator, amount) => {
    const item = coordinated(body).items[0]!;
    expect(item).toMatchObject({ description: name, quantityExact: { numerator, denominator }, lineTotalCents: amount });
    expect(item.evidence?.quantity).toMatchObject({ origin: "observed", needsReview: false });
  });

  it.each(["VITAMIN B 12\n8.00", "Description Amount\nVITAMIN B 12 8.00", "Description Qty Amount\nVITAMIN B 12\n| 8.00"])("preserves numeric names and unknown quantities on split/non-quantity layouts: %s", body => {
    const item = coordinated(body).items[0]!;
    expect(item).toMatchObject({ description: "VITAMIN B 12", quantityExact: null, lineTotalCents: 800 });
    expect(item.evidence?.quantity).toMatchObject({ origin: "unknown", needsReview: true });
  });

  it("retains an independently shaped split quantity and amount row", () => {
    const item = coordinated("VITAMIN B 12\n2 16.00").items[0]!;
    expect(item).toMatchObject({ description: "VITAMIN B 12", quantityExact: { numerator: 2, denominator: 1 }, lineTotalCents: 1600 });
    expect(item.evidence?.quantity?.sources).toHaveLength(2);
  });

  it("does not mine damaged split numeric fragments", () => {
    const item = coordinated("VITAMIN B 12\n3 4.00 V F").items[0]!;
    expect(item).toMatchObject({ description: "VITAMIN B 12", quantityExact: null, lineTotalCents: null, flagged: true });
  });

  it.each(["Description Unit Price Qty Amount\nCOFFEE 3.50 2 7.00", "Description Qty Unit Price Amount\nCOFFEE 2 3.50 7.00"])("keeps headed unit price distinct from the full amount: %s", body => {
    expect(coordinated(body).items[0]).toMatchObject({ description: "COFFEE", quantityExact: { numerator: 2, denominator: 1 }, unitPriceCents: 350, lineTotalCents: 700 });
  });
});

describe("Batch 1d: explicit @ quantity and unit price", () => {
  it.each([direct, coordinated])("does not silently use a lone unit price as the full line amount", parse => {
    const receipt = parse("COFFEE 2 @ 3.50\nTotal 7.00");
    expect(receipt.items[0]).toMatchObject({ description: "COFFEE", quantityExact: { numerator: 2, denominator: 1 }, unitPriceCents: 350, lineTotalCents: null, flagged: true });
    expect(receipt.items[0]!.evidence?.lineTotalCents).toMatchObject({ origin: "unknown", needsReview: true });
    expect(assessReceipt(receipt).reasons.some(reason => reason.path === "items[0].lineTotalCents")).toBe(true);
  });

  it("preserves an independent full amount instead of calculating one", () => {
    const item = coordinated("COFFEE 2 @ 3.50 7.00").items[0]!;
    expect(item).toMatchObject({ description: "COFFEE", quantityExact: { numerator: 2, denominator: 1 }, unitPriceCents: 350, lineTotalCents: 700 });
    for (const field of ["quantity", "unitPriceCents", "lineTotalCents"] as const) expect(item.evidence?.[field]).toMatchObject({ origin: "observed", needsReview: false });
  });

  it("preserves and flags a full-amount mismatch without repairing it", () => {
    const item = coordinated("COFFEE 2 @ 3.50 6.50").items[0]!;
    expect(item).toMatchObject({ description: "COFFEE", quantityExact: { numerator: 2, denominator: 1 }, unitPriceCents: 350, lineTotalCents: 650, flagged: true });
    for (const field of ["quantity", "unitPriceCents", "lineTotalCents"] as const) expect(item.evidence?.[field]?.needsReview).toBe(true);
  });

  it("supports fractional explicit quantities without manufacturing their full amount", () => {
    expect(coordinated("LOOSE TEA 1/2 @ $8.00").items[0]).toMatchObject({ description: "LOOSE TEA", quantityExact: { numerator: 1, denominator: 2 }, unitPriceCents: 800, lineTotalCents: null });
  });

  it("keeps a lone @ unit price separate when quantity is not identified", () => {
    const item = coordinated("COFFEE @ $3.50").items[0]!;
    expect(item).toMatchObject({ description: "COFFEE", quantityExact: null, unitPriceCents: 350, lineTotalCents: null, flagged: true });
    expect(item.evidence?.quantity).toMatchObject({ origin: "unknown", needsReview: true });
  });

  it("retains explicit leading multiplication with a lone @ unit price", () => {
    expect(coordinated("2 x COFFEE @ $3.50").items[0]).toMatchObject({ description: "COFFEE", quantityExact: { numerator: 2, denominator: 1 }, unitPriceCents: 350, lineTotalCents: null, flagged: true });
  });

  it("does not reinterpret a trailing numeric product identifier after explicit leading multiplication", () => {
    expect(coordinated("2 x VITAMIN B 12 @ $3.50 7.00").items[0]).toMatchObject({ description: "VITAMIN B 12", quantityExact: { numerator: 2, denominator: 1 }, unitPriceCents: 350, lineTotalCents: 700 });
  });
});
