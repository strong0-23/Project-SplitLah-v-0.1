import { describe, expect, it } from "vitest";
import { parseRecognitionDocument } from "./recognition-parser";
import { documentFromTesseract, type RecognitionDocument } from "./recognition-document";
import type { OcrResult } from "./ocr";

const text = "SYNTHETIC SHOP\nProduct Qty Total\nJUICE 500ml 2 4.00\nTotal 4.00";
const tess = (): RecognitionDocument => documentFromTesseract({ text, selectedAttempt: 0, attempts: [{ text }] } as OcrResult);
describe("engine-independent interpretation and source binding", () => {
  it("uses the same financial parser and preserves engine/attempt evidence", () => {
    const t = tess(), p = structuredClone(t);
    p.engine = "paddle";
    p.lines.forEach((line, index) => { line.source = { engine: "paddle", attemptIndex: 3, lineIndices: [index], boxIndices: [index * 2, index * 2 + 1] }; });
    const a = parseRecognitionDocument(t).receipt, b = parseRecognitionDocument(p).receipt;
    expect(a.items[0]).toMatchObject({ description: "JUICE 500ml", quantity: 2, lineTotalCents: 400 });
    expect(a.items[0]!.flagged).toBe(false); // an absent optional unit price is not an item failure
    expect(b.items[0]).toMatchObject({ description: a.items[0]!.description, quantity: 2, lineTotalCents: 400 });
    expect(b.items[0]!.evidence!.lineTotalCents!.sources[0]).toMatchObject({ engine: "paddle", attemptIndex: 3, boxIndices: [4, 5] });
    expect(a.items[0]!.evidence!.lineTotalCents!.sources[0]).toMatchObject({ engine: "tesseract", attemptIndex: 0 });
  });
  it("keeps ambiguous geometry visible without changing the recognised amount", () => {
    const doc = tess(); doc.lines[2]!.uncertain = true;
    const receipt = parseRecognitionDocument(doc).receipt;
    expect(receipt.items[0]).toMatchObject({ lineTotalCents: 400, flagged: true });
    expect(receipt.items[0]!.evidence!.lineTotalCents!.needsReview).toBe(true);
    expect(receipt.rows!.find(row => row.role === "product")!.needsReview).toBe(true);
  });
  it("does not treat unrelated heading uncertainty as uncertain financial evidence", () => {
    const doc = tess(); doc.lines[0]!.uncertain = true;
    const receipt = parseRecognitionDocument(doc).receipt;
    expect(receipt.items[0]!.evidence!.lineTotalCents!.needsReview).toBe(false);
  });
});
