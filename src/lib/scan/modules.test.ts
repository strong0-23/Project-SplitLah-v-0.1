import { describe, expect, it, vi } from "vitest";
import { fitScale } from "./canvas";
import { groupRows, pageToLines } from "./layout";
import { classifyLabel } from "./lexicon";
import { detectCurrency, detectFormat, findAmounts, fixOcrDigits } from "./numbers";
import { parseReceiptText } from "./parse";
import { EnginePool } from "./engine-pool";
import { PARTLY_READ_NOTE, scanReceipt } from "./index";
import { runOcr } from "./scan";
import type { OcrEngine, OcrWord } from "./types";

const w = (
  text: string,
  x0: number,
  y0: number,
  x1 = x0 + text.length * 10,
  y1 = y0 + 20,
): OcrWord => ({ text, confidence: 90, bbox: { x0, y0, x1, y1 } });

describe("layout", () => {
  it("keeps a skewed row together and marks the price column gap", () => {
    const words = [
      w("FRIED", 10, 100),
      w("RICE", 70, 102),
      w("8.50", 400, 112),
      w("TEA", 10, 140),
      w("1.80", 400, 150),
    ];
    expect(groupRows(words).length).toBe(2);
    expect(pageToLines({ text: "", words })).toEqual(["FRIED RICE  8.50", "TEA  1.80"]);
  });
  it("falls back to engine text lines without word boxes", () => {
    expect(pageToLines({ text: "A  1.00\n\n  B 2.00 ", words: [] })).toEqual(["A  1.00", "B 2.00"]);
  });
});

describe("numbers", () => {
  it("reads negative forms", () => {
    expect(findAmounts("Disc -2.00").map((a) => [a.cents, a.negative])).toEqual([[200, true]]);
    expect(findAmounts("Disc 2.00-").map((a) => a.negative)).toEqual([true]);
    expect(findAmounts("Disc (2.00)").map((a) => a.negative)).toEqual([true]);
    expect(findAmounts("Refund 2.00 CR").map((a) => a.negative)).toEqual([true]);
  });
  it("records the printed text of an amount whose digits were repaired", () => {
    expect(findAmounts("Tea 1O.5O")).toMatchObject([{ cents: 1050, repairedFrom: "1O.5O" }]);
    expect(findAmounts("Tea 10.50")[0]).not.toHaveProperty("repairedFrom");
  });
  it("leaves volumes and ounces alone when fixing OCR digits", () => {
    expect(fixOcrDigits("Coke 1.5l 2.0O")).toBe("Coke 1.5l 2.00");
    expect(fixOcrDigits("4oz Steak l2.5O")).toBe("4oz Steak 12.50");
  });
  it("detects currency and format", () => {
    expect(detectCurrency(["S$ 4.50"]).code).toBe("SGD");
    expect(detectCurrency(["$4.50"]).code).toBeNull();
    expect(detectFormat(["Tea 3,50", "Cake 4,20", "Ref 1.10.2026"])).toEqual({
      decimal: ",",
      minorDigits: 2,
    });
  });
});

describe("lexicon", () => {
  it("reads charge lines with extra words", () => {
    expect(
      [
        "Service Charge 10%",
        "GST 9% incl",
        "Member Disc",
        "VISA Credit ****1234",
        "Cash Tendered",
        "Rounding Adj",
      ].map(classifyLabel),
    ).toEqual(["service", "tax", "discount", "payment", "payment", "rounding"]);
  });
  it("never treats product names as charges", () => {
    for (const name of [
      "BUTTER CHICKEN B.LESS",
      "TAX-FREE COLA",
      "Service Tea",
      "Totally Fries",
      "Change Burger",
    ]) {
      expect(classifyLabel(name), name).toBeNull();
    }
  });
});

describe("parser edge cases", () => {
  it("moves item discounts to the bill when the printed subtotal is before discounts", () => {
    const { receipt: r } = parseReceiptText(
      `SHOP\nShirt 20.00\nPromo -5.00\nSubtotal 20.00\nTotal 15.00`,
    );
    expect(r.items[0]!.lineTotalCents).toBe(2000);
    expect(r.discountCents).toBe(500);
  });
  it("uses the last total before payment (Total then Grand Total)", () => {
    const { receipt: r } = parseReceiptText(
      `SHOP\nRice 10.00\nTotal 10.00\nGST 0.90\nGrand Total 10.90\nCash 20.00\nTotal 9.10`,
    );
    expect(r.receiptTotalCents).toBe(1090);
  });
});

describe("canvas sizing", () => {
  it("keeps long receipts wide enough to read", () => {
    const s = fitScale(1500, 9000, 7_000_000);
    expect(Math.round(1500 * s)).toBeGreaterThanOrEqual(1000);
    expect(fitScale(800, 600, 7_000_000)).toBe(1);
  });
});

describe("scan workflow with an injected engine", () => {
  it("runs a second pass only when the first is inconsistent and keeps the better one", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 2, height: 2, close: vi.fn() }),
    );
    const px = () => ({ data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2 });
    vi.spyOn(document, "createElement").mockReturnValue({
      width: 2,
      height: 2,
      getContext: () => ({
        scale: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        drawImage: vi.fn(),
        getImageData: px,
        createImageData: px,
        putImageData: vi.fn(),
      }),
      toBlob: (cb: (b: Blob) => void) => cb(new Blob(["p"])),
    } as unknown as HTMLCanvasElement);
    const pages = { column: "bad", block: "good" } as Record<string, string>;
    const engine: OcrEngine = {
      name: "fake",
      load: vi.fn(async () => undefined),
      recognize: vi.fn(async (_b, layout) => ({ text: pages[layout] ?? "", words: [] })),
      terminate: vi.fn(async () => undefined),
    };
    const res = await runOcr(
      new File(["x"], "r.jpg", { type: "image/jpeg" }),
      { rotation: 0, crop: null },
      () => undefined,
      new AbortController().signal,
      {
        createEngine: () => engine,
        scorer: (lines) => ({ score: lines[0] === "good" ? 5 : 1, good: false }),
      },
    );
    expect(res).toMatchObject({ lines: ["good"], passes: 2, engine: "fake" });
    expect(engine.terminate).toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

describe("scan: a partly read photo is said so on the receipt (D14)", () => {
  /** A 10-row prepared image whose every row holds print; the engine reads only the top rows. */
  async function scanWith(wordRows: number) {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 10, height: 10, close: vi.fn() }),
    );
    const px = () => ({ data: new Uint8ClampedArray(400).fill(20), width: 10, height: 10 });
    vi.spyOn(document, "createElement").mockReturnValue({
      width: 10,
      height: 10,
      getContext: () => ({
        scale: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        drawImage: vi.fn(),
        getImageData: px,
        createImageData: px,
        putImageData: vi.fn(),
      }),
      toBlob: (cb: (b: Blob) => void) => cb(new Blob(["p"])),
    } as unknown as HTMLCanvasElement);
    const words = Array.from({ length: wordRows }, (_, i) => w("Tea 1.00", 0, i, 50, i + 1));
    const engine: OcrEngine = {
      name: "fake",
      load: vi.fn(async () => undefined),
      recognize: vi.fn(async () => ({ text: "Tea 1.00", words })),
      terminate: vi.fn(async () => undefined),
    };
    try {
      return await scanReceipt(
        new File(["x"], "r.jpg", { type: "image/jpeg" }),
        { rotation: 0, crop: null },
        () => undefined,
        new AbortController().signal,
        () => engine,
        new EnginePool(),
      );
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  }

  it("adds the note first in the receipt's existing warnings when most print went unread", async () => {
    const res = await scanWith(2);
    expect(res.receipt.ocrWarnings?.[0]).toBe(PARTLY_READ_NOTE);
    expect(res.warnings[0]).toBe(PARTLY_READ_NOTE);
  });

  it("adds nothing when the words cover the printed rows", async () => {
    const res = await scanWith(10);
    expect(res.receipt.ocrWarnings ?? []).not.toContain(PARTLY_READ_NOTE);
  });
});
