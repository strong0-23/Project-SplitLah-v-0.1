import { describe, expect, it } from "vitest";
import { adaptPaddleTextBoxes, type PaddleTextBox } from "../../tools/ocr-engine-sandbox/adapter";
import { documentFromPaddle, documentFromTesseract } from "./recognition-document";
import type { OcrResult } from "./ocr";

const tesseract = (text: string): OcrResult => ({ text, rotation: 0, crop: null, passes: 1, selectedAttempt: 0, attempts: [{ text, preprocessing: "flattened", pageSegmentation: "4", score: 1, good: false }] });
const box = (text: string, x: number, y: number, width: number, score = .94): PaddleTextBox => ({ text, poly: [[x, y], [x + width, y], [x + width, y + 10], [x, y + 10]], score });

describe("engine-neutral recognition evidence", () => {
  it("preserves numeric characters, blank lines and selected Tesseract text exactly", () => {
    const input = tesseract("SHOP\r\n500ml 2-pack I.20\r\n\r\nT0TAL 2.40");
    const result = documentFromTesseract(input);
    expect(result.text).toBe(input.text);
    expect(result.lines.map(line => line.text)).toEqual(["SHOP", "500ml 2-pack I.20", "", "T0TAL 2.40"]);
    expect(result.lines[3]!.source).toEqual({ engine: "tesseract", attemptIndex: 0, boxIndices: [], lineIndices: [3] });
    expect(result.lines.every(line => !line.uncertain && !line.geometry)).toBe(true);
  });

  it("retains optional Tesseract word boxes without guessing word-to-line geometry", () => {
    const input = tesseract("Product 2 4.00");
    input.attempts[0]!.words = [{ text: "2", confidence: 96, bbox: { x0: 50, y0: 10, x1: 60, y1: 20 } }];
    const result = documentFromTesseract(input);
    expect(result.rawBoxes[0]).toMatchObject({ text: "2", polygon: [[50, 10], [60, 10], [60, 20], [50, 20]], nativeConfidence: { engine: "tesseract", scale: "tesseract-0-100", values: [96] } });
    expect(result.lines[0]!.geometry).toBeUndefined();
    expect(result.lines[0]!.nativeConfidence).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "line-geometry-unavailable", severity: "info" }));
  });

  it("flags selected-attempt mismatches rather than borrowing another attempt's words", () => {
    const input = tesseract("Selected text");
    input.attempts[0]!.text = "Another text";
    input.attempts[0]!.words = [{ text: "Other", confidence: 99, bbox: { x0: 0, y0: 0, x1: 40, y1: 10 } }];
    const result = documentFromTesseract(input);
    expect(result.text).toBe("Selected text");
    expect(result.rawBoxes).toEqual([]);
    expect(result.lines[0]!.source.attemptIndex).toBeUndefined();
    expect(result.lines[0]!.uncertain).toBe(true);
    expect(result.diagnostics[0]!.kind).toBe("selected-attempt-mismatch");
  });

  it("maps supported Paddle reading order and box indices without business interpretation", () => {
    const boxes = [box("4.00", 250, 20, 30), box("2-pack 500ml", 10, 20, 120), box("2", 200, 20, 10), box("T0TAL", 10, 50, 50), box("4.00", 250, 50, 30)];
    const adapted = adaptPaddleTextBoxes(boxes);
    const result = documentFromPaddle(boxes, adapted, 2);
    expect(result.text).toBe("2-pack 500ml 2 4.00\nT0TAL 4.00");
    expect(result.lines[0]!.source).toEqual({ engine: "paddle", attemptIndex: 2, boxIndices: [1, 2, 0], lineIndices: [0] });
    expect(result.lines[0]!.geometry).toMatchObject({ coordinateSpace: "ocr-input", bounds: { left: 10, top: 20, right: 280, bottom: 30 }, angleDegrees: 0 });
    expect(result.lines.every(line => !line.uncertain)).toBe(true);
    expect(result.rawBoxes.map(value => value.text)).toEqual(boxes.map(value => value.text));
  });

  it("retains duplicate or competing detections as separate uncertain lines", () => {
    const boxes = [box("Item A", 10, 10, 80), box("Item A", 10, 10, 80)];
    const result = documentFromPaddle(boxes, adaptPaddleTextBoxes(boxes));
    expect(result.lines).toHaveLength(2);
    expect(result.lines.every(line => line.uncertain)).toBe(true);
    expect(result.lines.map(line => line.source.boxIndices)).toEqual([[0], [1]]);
    expect(result.rawBoxes).toHaveLength(2);
    expect(result.diagnostics[0]!.kind).toBe("ambiguous-row");
  });

  it("keeps rejected source text inspectable and diagnoses unsupported line evidence", () => {
    const boxes = [box("Good", 10, 10, 40), { text: "Unlocated", poly: [[0, 0], [0, 0], [0, 0], [0, 0]], score: .95 }];
    const adapted = adaptPaddleTextBoxes(boxes);
    const result = documentFromPaddle(boxes, adapted);
    expect(result.text).toBe("Good");
    expect(result.rawBoxes[1]).toMatchObject({ text: "Unlocated", uncertain: true });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "invalid-box", boxIndices: [1] }));
    const reused = structuredClone(adapted);
    reused.lines.push({ ...reused.lines[0]!, boxIndices: [0] });
    reused.text = "Good\nGood";
    const conflict = documentFromPaddle(boxes, reused);
    expect(conflict.lines.every(line => line.uncertain)).toBe(true);
    expect(conflict.diagnostics).toContainEqual(expect.objectContaining({ kind: "reused-source-box", boxIndices: [0], lineIndices: [0, 1] }));
  });

  it("preserves engine-specific native confidence scales and does not alias input arrays", () => {
    const boxes = [box("Value", 10, 10, 60, .96)];
    const adapted = adaptPaddleTextBoxes(boxes);
    const result = documentFromPaddle(boxes, adapted);
    expect(result.lines[0]!.nativeConfidence).toEqual({ engine: "paddle", scale: "paddle-0-1", values: [.96] });
    result.lines[0]!.geometry!.polygons[0]![0]![0] = 999;
    result.lines[0]!.source.boxIndices.push(999);
    expect(boxes[0]!.poly[0]![0]).toBe(10);
    expect(adapted.lines[0]!.boxIndices).toEqual([0]);
    const invalid = documentFromPaddle([{ ...boxes[0]!, score: 96 }], adapted);
    expect(invalid.rawBoxes[0]!.nativeConfidence).toBeUndefined();
    expect(invalid.lines[0]!.uncertain).toBe(true);
    expect(invalid.diagnostics[0]!.kind).toBe("invalid-native-confidence");
  });
});
