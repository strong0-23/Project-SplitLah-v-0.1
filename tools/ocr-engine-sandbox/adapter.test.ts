import { describe, expect, it } from "vitest";
import { adaptPaddleTextBoxes, type PaddleTextBox } from "./adapter";

function box(text: string, x: number, y: number, width: number, height = 10, degrees = 0): PaddleTextBox {
  const angle = degrees * Math.PI / 180;
  const rotate = (px: number, py: number) => [px * Math.cos(angle) - py * Math.sin(angle), px * Math.sin(angle) + py * Math.cos(angle)];
  return { text, score: 0.95, poly: [rotate(x, y), rotate(x + width, y), rotate(x + width, y + height), rotate(x, y + height)] };
}

describe("PaddleOCR geometry adapter", () => {
  it("reconstructs separate table columns without changing recognised text", () => {
    const result = adaptPaddleTextBoxes([
      box("5.20", 200, 30, 30), box("Example Product", 10, 30, 100), box("2", 150, 30, 8),
      box("SHOP", 60, 0, 60), box("TOTAL", 10, 60, 50), box("5.20", 200, 60, 30),
    ]);
    expect(result.text).toBe("SHOP\nExample Product 2 5.20\nTOTAL 5.20");
    expect(result.lines[1]!.boxIndices).toEqual([1, 2, 0]);
    expect(result.diagnostics).toEqual([]);
  });

  it("uses observed sloped box geometry rather than unrotated centre heights", () => {
    const result = adaptPaddleTextBoxes([
      box("Sample Product", 10, 10, 100, 10, 7), box("2", 180, 10, 8, 10, 7), box("8.40", 260, 10, 30, 10, 7),
      box("Next Product", 10, 30, 95, 10, 7), box("3.10", 260, 30, 30, 10, 7),
    ]);
    expect(result.text).toBe("Sample Product 2 8.40\nNext Product 3.10");
    expect(result.angleDegrees).toBeCloseTo(7, 5);
    expect(result.lines.every((line) => !line.uncertain)).toBe(true);
  });

  it("does not borrow an amount from the next product row", () => {
    const result = adaptPaddleTextBoxes([
      box("No visible price", 10, 10, 100), box("Second Product", 10, 22, 100), box("7.30", 200, 22, 30),
    ]);
    expect(result.text).toBe("No visible price\nSecond Product 7.30");
    expect(result.lines[0]!.boxIndices).toEqual([0]);
  });

  it("isolates conflicting memberships instead of guessing which row owns an amount", () => {
    const result = adaptPaddleTextBoxes([
      box("First Product", 10, 10, 100), box("Second Product", 10, 17, 100), box("9.90", 200, 13.5, 30),
    ]);
    expect(result.lines).toHaveLength(3);
    expect(result.lines.every((line) => line.boxIndices.length === 1 && line.uncertain)).toBe(true);
    expect(result.diagnostics[0]!.kind).toBe("ambiguous-row");
  });

  it("rejects invalid geometry with source diagnostics rather than emitting unlocated text", () => {
    const result = adaptPaddleTextBoxes([
      { text: "bad", score: 0.9, poly: [[0, 0], [0, 0], [0, 0], [0, 0]] },
      { text: "NaN", score: 0.9, poly: [[0, 0], [10, 0], [10, Number.NaN], [0, 10]] },
      box("Good", 0, 40, 30), box("  ", 0, 60, 30),
    ]);
    expect(result.text).toBe("Good");
    expect(result.rejectedBoxIndices).toEqual([0, 1, 3]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["invalid-box", "invalid-box", "empty-text"]);
  });

  it("produces the same ordered text when SDK detection order changes", () => {
    const boxes = [box("A", 10, 0, 10), box("1", 100, 0, 8), box("3.40", 180, 0, 30), box("B", 10, 20, 10), box("6.80", 180, 20, 30)];
    expect(adaptPaddleTextBoxes(boxes).text).toBe("A 1 3.40\nB 6.80");
    expect(adaptPaddleTextBoxes([boxes[4]!, boxes[2]!, boxes[0]!, boxes[3]!, boxes[1]!]).text).toBe(adaptPaddleTextBoxes(boxes).text);
  });

  it("flags overlapping detections and keeps their order reproducible", () => {
    const a = box("Possible A", 10, 10, 80);
    const b = box("Possible B", 10, 10, 80);
    const result = adaptPaddleTextBoxes([b, a]);
    expect(result.text).toBe("Possible A\nPossible B");
    expect(result.lines.every((line) => line.uncertain)).toBe(true);
    expect(result.diagnostics[0]!.kind).toBe("ambiguous-row");
    expect(adaptPaddleTextBoxes([a, b]).text).toBe(result.text);
  });
});
