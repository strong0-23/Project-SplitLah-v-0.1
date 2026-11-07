import { describe, expect, it } from "vitest";
import { parseReceiptText } from "./parser";
import { parseOcrResult } from "./receipt-reading";
import { scoreOcrText } from "./scan-score";
import type { OcrResult } from "./ocr";
import type { OcrWord } from "./ocr-regions";
import { parseRecognitionDocument } from "./recognition-parser";
import { documentFromTesseract } from "./recognition-document";

const body = "EXAMPLE MARKET\nROLLED GRAINS 400G\n[ 4.20 V\nPAPER BAG 1 0.10\nDENTAL PICKS 50M\n| 2 JNO 4";
const noisy = "NOISY HEADING\nROLLED GRAINS 400G\n: 4.20 V 2\nPAPER BAG 1 0.10\nDENTAL PICKS 50M\n| 2 JNO 4";
const alternate = `${noisy}\nTotal 9.50\nMASTER 9.50`;
function result(texts: string[], selectedAttempt = 0): OcrResult {
  return { text: texts[selectedAttempt]!, rotation: 0, crop: null, passes: texts.length, selectedAttempt,
    attempts: texts.map(text => ({ text, preprocessing: "flattened", pageSegmentation: "6", ...scoreOcrText(text) })) };
}
const itemsWithoutIds = (text: string) => parseRecognitionDocument(documentFromTesseract(result([text]))).receipt.items.map(({ id, ...item }) => item);

describe("corroborated alternate total recovery (synthetic receipts)", () => {
  it("preserves the selected body and every uncertainty with explicit source evidence", () => {
    const ocr = result([body, alternate]);
    const before = JSON.stringify(ocr);
    const parsed = parseOcrResult(ocr);
    expect(parsed.receipt.merchant).toBe("EXAMPLE MARKET");
    expect(parsed.receipt.items.map(({ id, ...item }) => item)).toEqual(itemsWithoutIds(body));
    expect(parsed.receipt.rawOcrText).toBe(body);
    expect(parsed.receipt.receiptTotalCents).toBe(950);
    expect(parsed.receipt.uncertainFields).toEqual(parseReceiptText(body).receipt.uncertainFields);
    expect(parsed.receipt.uncertainFields).toContain("total");
    expect(parsed.receipt.items[2]).toMatchObject({ lineTotalCents: null, flagged: true });
    expect(parsed.receipt.items[0]!.evidence!.description!.sources[0]).toMatchObject({ engine: "tesseract", attemptIndex: 0 });
    expect(parsed.recoveredTotal).toEqual({ attemptIndex: 1, cents: 950, totalLabel: "Total", paymentLabel: "MASTER", needsReview: true });
    expect(parsed.warnings).not.toContain("Receipt total not found — enter it to check the maths.");
    expect(parsed.warnings).toContain("The printed total was recovered from another reading with a matching electronic payment. Confirm the total; item uncertainties remain.");
    expect(parsed.receipt.ocrWarnings).toEqual(parsed.warnings);
    expect(JSON.stringify(ocr)).toBe(before);
  });

  it.each(["", "MASTER 8.50", "Cash 9.50", "Change 9.50", "Card balance 9.50", "Credit balance 9.50", "VISA balance 9.50", "VISA BAG 9.50", "MASTER GIFT 9.50", "MASTER 9.50-", "MASTER 9.50- F", "VISA -9.50", "MASTER 9.50\nVISA 1.00", "MASTER 9.50\nMASTER 9.50"])("does not recover from missing, ambiguous or split payment evidence: %s", payment => {
    const parsed = parseOcrResult(result([body, `${noisy}\nTotal 9.50\n${payment}`]));
    expect(parsed.receipt.receiptTotalCents).toBeNull();
    expect(parsed.recoveredTotal).toBeUndefined();
  });

  it.each(["MASTER - Ne 9.50", "VISA ****0000 9.50", "PAYNOW 9.50"])("accepts explicit payment labels and their references: %s", payment => {
    expect(parseOcrResult(result([body, `${noisy}\nTotal 9.50\n${payment}`])).receipt.receiptTotalCents).toBe(950);
  });

  it.each(["Total -9.50", "Total 9.50-", "Total 9.50- V", "Total 950", "Total 9.500"])("does not repair a damaged or signed total: %s", total => {
    const parsed = parseOcrResult(result([body, `${noisy}\n${total}\nMASTER 9.50`]));
    expect(parsed.receipt.receiptTotalCents).toBeNull();
  });

  it("treats literal zero as evidence without resolving any body uncertainty", () => {
    const parsed = parseOcrResult(result([body, `${noisy}\nTotal 0.00\nMASTER 0.00`]));
    expect(parsed.receipt.receiptTotalCents).toBe(0);
    expect(parsed.recoveredTotal?.needsReview).toBe(true);
    expect(parsed.receipt.uncertainFields).toContain("total");
    expect(parsed.receipt.items[2]!.lineTotalCents).toBeNull();
  });

  it("rejects conflicting totals within a reading or across readings", () => {
    expect(parseOcrResult(result([body, `${alternate}\nTotal 8.50`])).receipt.receiptTotalCents).toBeNull();
    expect(parseOcrResult(result([body, alternate, `${noisy}\nTotal 8.50\nVISA 8.50`])).receipt.receiptTotalCents).toBeNull();
  });

  it("does not combine a total from one alternate and a payment from another", () => {
    expect(parseOcrResult(result([body, `${noisy}\nTotal 9.50`, `${noisy}\nMASTER 9.50`])).receipt.receiptTotalCents).toBeNull();
  });

  it("keeps tender ambiguity within its source reading and requires a complete independent alternate", () => {
    expect(parseOcrResult(result([body, alternate, "Cash 20.00\nChange 10.50"])).receipt.receiptTotalCents).toBe(950);
    expect(parseOcrResult(result([body, `${alternate}\nCash 1.00`])).receipt.receiptTotalCents).toBeNull();
    expect(parseOcrResult(result([body, `${noisy}\nTotal 9.50`, "VISA 9.50"])).receipt.receiptTotalCents).toBeNull();
  });

  it("requires the same item count and a shared confident body item", () => {
    expect(parseOcrResult(result([body, alternate.replace("PAPER BAG", "OTHER ITEM")])).receipt.receiptTotalCents).toBeNull();
    expect(parseOcrResult(result([body, alternate.replace("PAPER BAG 1 0.10\n", "")])).receipt.receiptTotalCents).toBeNull();
    expect(parseOcrResult(result([body, "Total 9.50\nMASTER 9.50"])).receipt.receiptTotalCents).toBeNull();
  });

  it("uses observed identity and amount when quantity remains unknown, retaining its uncertainty", () => {
    const selected = "SHOP\nProduct Qty Total\nGREEN TEA 0.10";
    const parsed = parseOcrResult(result([selected, `${selected}\nTotal 0.10\nMASTER 0.10`]));
    expect(parsed.receipt.receiptTotalCents).toBe(10);
    expect(parsed.receipt.items[0]).toMatchObject({ quantityExact: null, flagged: true });
    expect(parsed.receipt.items[0]!.evidence!.quantity).toMatchObject({ origin: "unknown", needsReview: true });
    expect(parsed.receipt.evidence!.total).toMatchObject({ origin: "observed", needsReview: true });
  });

  it("does not corroborate a body with conflicting observed quantities", () => {
    const selected = "SHOP\nProduct Qty Total\nGREEN TEA 2 0.10";
    const other = "SHOP\nProduct Qty Total\nGREEN TEA 3 0.10\nTotal 0.10\nMASTER 0.10";
    expect(parseOcrResult(result([selected, other])).receipt.receiptTotalCents).toBeNull();
  });

  it("never overrides an existing total or attaches evidence to mismatched selected text", () => {
    const existing = parseOcrResult(result([`${body}\nTotal 8.50`, alternate]));
    expect(existing.receipt.receiptTotalCents).toBe(850);
    expect(existing.recoveredTotal).toBeUndefined();
    const mismatched = result([body, alternate]); mismatched.text = body + "\nDifferent selected text";
    expect(parseOcrResult(mismatched).receipt.receiptTotalCents).toBeNull();
    expect(parseOcrResult(result(["Paid by", alternate])).receipt.receiptTotalCents).toBeNull();
  });
});

describe("targeted item evidence (synthetic receipts)", () => {
  function evidence() {
    const ocr = result([body]);
    const word = (text: string, x0: number, y0: number, x1: number, y1: number): OcrWord => ({ text, confidence: 90, bbox: { x0, y0, x1, y1 } });
    const words = [word("DENTAL", 10, 10, 90, 30), word("PICKS", 100, 10, 160, 30), word("50M", 170, 10, 210, 30), word("2", 230, 40, 240, 60), word("5.20", 280, 40, 320, 60)];
    ocr.itemReadings = [{ itemIndex: 2, description: "DENTAL PICKS 50M", sourceAttempt: 0,
      crop: { left: .1, top: .2, right: .9, bottom: .3 },
      attempts: ["4", "6"].map(pageSegmentation => ({ text: "DENTAL PICKS 50M\n2 5.20", words: structuredClone(words), pageSegmentation: pageSegmentation as "4" | "6" })) }];
    return ocr;
  }

  it("fills only the unknown line amount with provenance while retaining quantity and review flags", () => {
    const ocr = evidence(); const before = parseRecognitionDocument(documentFromTesseract(ocr)).receipt;
    const parsed = parseOcrResult(ocr);
    expect(parsed.receipt.items[2]).toMatchObject({ description: "DENTAL PICKS 50M", quantity: 1, lineTotalCents: 520, flagged: true });
    expect(parsed.receipt.items.slice(0, 2).map(({ id, ...i }) => i)).toEqual(before.items.slice(0, 2).map(({ id, ...i }) => i));
    expect(parsed.receipt.merchant).toBe(before.merchant);
    expect(parsed.receipt.rawOcrText).toBe(body);
    expect(parsed.receipt.uncertainFields).toEqual(before.uncertainFields);
    expect(parsed.recoveredItems).toEqual([{ itemIndex: 2, readingIndex: 0, cents: 520, observedQuantity: 2, sourceAttempt: 0, needsReview: true }]);
    expect(parsed.warnings.some(w => /item line\(s\) were read without a price/.test(w))).toBe(false);
  });

  it("retains direct target amount evidence independently of an unrelated ambiguous offer", () => {
    const ocr = evidence();
    ocr.text += "\n2 FOR $6.00 1.00-";
    ocr.attempts[0]!.text = ocr.text;
    expect(parseReceiptText(ocr.text).receipt.uncertainFields).toContain("discount");
    expect(scoreOcrText(ocr.text).recoveryItems).toContainEqual({ index: 2, description: "DENTAL PICKS 50M" });
    const receipt = parseOcrResult(ocr).receipt;
    expect(receipt.items[2]).toMatchObject({ lineTotalCents: 520, quantityExact: null, flagged: true });
    expect(receipt.evidence!.discountCents!.needsReview).toBe(true);
  });

  it.each(["one reading", "same layout", "duplicate target", "weak price", "weak name", "conflicting price", "conflicting quantity", "signed row", "different source", "wrong descriptor", "two products", "error"])("leaves the amount unknown with insufficient evidence: %s", failure => {
    const ocr = evidence(); const r = ocr.itemReadings![0]!;
    if (failure === "one reading") r.attempts.pop();
    if (failure === "same layout") r.attempts[1]!.pageSegmentation = "4";
    if (failure === "duplicate target") ocr.itemReadings!.push(structuredClone(r));
    if (failure === "weak price") r.attempts[1]!.words[4]!.confidence = 20;
    if (failure === "weak name") r.attempts[1]!.words[0]!.confidence = 20;
    if (failure === "conflicting price") r.attempts[1]!.text = "DENTAL PICKS 50M\n2 6.20";
    if (failure === "conflicting quantity") r.attempts[1]!.text = "DENTAL PICKS 50M\n3 5.20";
    if (failure === "signed row") r.attempts[1]!.words.push({ text: "-", confidence: 90, bbox: { x0: 325, y0: 40, x1: 330, y1: 60 } });
    if (failure === "different source") r.sourceAttempt = 1;
    if (failure === "wrong descriptor") r.description = "ANOTHER PRODUCT";
    if (failure === "two products") r.attempts[1]!.text += "\nOTHER PRODUCT 2 5.20";
    if (failure === "error") r.error = "recognition failed";
    const parsed = parseOcrResult(ocr);
    expect(parsed.receipt.items[2]!.lineTotalCents).toBeNull();
    expect(parsed.recoveredItems).toBeUndefined();
  });

  it("never overwrites a known amount or borrows evidence shared by ambiguous product names", () => {
    const known = evidence(); known.text = body.replace("| 2 JNO 4", "2 7.00"); known.attempts[0]!.text = known.text;
    expect(parseOcrResult(known).receipt.items[2]!.lineTotalCents).toBe(700);
    const ambiguous = evidence(); ambiguous.text += "\nDENTAL PICKS 100M\n| JNO 4"; ambiguous.attempts[0]!.text = ambiguous.text;
    expect(parseOcrResult(ambiguous).recoveredItems).toBeUndefined();
  });

  it("does not attach a neighbouring product's amount to a retained unpriced descriptor", () => {
    const ocr = evidence();
    const text = "DENTAL PICKS 50M\nOTHER PRODUCT 2 5.20";
    // A region may contain the target's name while the only parsed priced row belongs
    // to its neighbour. Name words elsewhere in the crop are insufficient evidence.
    expect(parseReceiptText(`OCR ITEM REGION\nProduct Qty Total\n${text}`).receipt.items)
      .toMatchObject([{ description: "OTHER PRODUCT", lineTotalCents: 520 }]);
    for (const attempt of ocr.itemReadings![0]!.attempts) attempt.text = text;
    const parsed = parseOcrResult(ocr);
    expect(parsed.receipt.items[2]!.lineTotalCents).toBeNull();
    expect(parsed.recoveredItems).toBeUndefined();
  });

  it.each(["DENTAL PICKS 50M 2 -5.20", "DENTAL PICKS 50M 2 5.20-"])("retains selected-source sign ambiguity even when closer readings lose the minus: %s", signed => {
    const ocr = evidence();
    ocr.text = body.replace("DENTAL PICKS 50M\n| 2 JNO 4", signed);
    ocr.attempts[0]!.text = ocr.text;
    const before = parseReceiptText(ocr.text).receipt;
    expect(before.uncertainFields).toContain("discount");
    expect(before.items[2]!.lineTotalCents).toBeNull();
    const parsed = parseOcrResult(ocr);
    expect(parsed.receipt.items[2]!.lineTotalCents).toBeNull();
    expect(parsed.recoveredItems).toBeUndefined();
    expect(parsed.receipt.uncertainFields).toEqual(before.uncertainFields);
    expect(scoreOcrText(ocr.text).recoveryItems).toEqual([]);
  });
});
