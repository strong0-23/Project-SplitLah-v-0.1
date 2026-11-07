import { afterEach, describe, expect, it, vi } from "vitest";
import { LOAD_TIMEOUT_MS, OcrCancelled, runOcr } from "./ocr";
import { scoreOcrText } from "./scan-score";
import { parseReceiptText } from "./parser";
import { parseOcrResult } from "./receipt-reading";

const mocks = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock("tesseract.js", () => ({ createWorker: mocks.createWorker, OEM: { LSTM_ONLY: 1 } }));

const file = new File(["image"], "receipt.jpg", { type: "image/jpeg" });
const options = { rotation: 0 as const, crop: { left: 0, top: 0, right: 1, bottom: 1 } };
const scorer = () => ({ score: 1, good: true });
const tick = () => vi.advanceTimersByTimeAsync(1);

function setup() {
  vi.useFakeTimers();
  const bitmap = { width: 2, height: 2, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  const pixels = () => ({ data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2 });
  vi.spyOn(document, "createElement").mockReturnValue({
    width: 2, height: 2,
    getContext: () => ({ scale: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), getImageData: pixels, createImageData: pixels, putImageData: vi.fn() }),
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["pixels"])),
  } as unknown as HTMLCanvasElement);
  return bitmap;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.createWorker.mockReset(); });

describe("OCR pass selection", () => {
  const useful = "EXAMPLE CINEMA\nUnit(g) Qty Amount\nSPACE FILM (Adult) 990 3 7 27.00 -\nGrand Total ( INCL GST) © $27.00\nCredit 27.00";
  const footer = "Paid By\nCredit 27.00\nTransaction Date example";
  it.each([false, true])("keeps the useful reading with footer first = %s", async (footerFirst) => {
    setup();
    const worker = {
      setParameters: vi.fn().mockResolvedValue(undefined),
      recognize: vi.fn()
        .mockResolvedValueOnce({ data: { text: footerFirst ? footer : useful } })
        .mockResolvedValueOnce({ data: { text: footerFirst ? useful : footer } })
        .mockResolvedValueOnce({ data: { text: footer } }),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createWorker.mockResolvedValue(worker);
    const result = await runOcr(file, options, vi.fn(), new AbortController().signal, scoreOcrText);
    expect(result).toMatchObject({ text: useful, passes: 3, selectedAttempt: footerFirst ? 1 : 0 });
    expect(scoreOcrText(footer).score).toBeLessThan(scoreOcrText(useful).score);
    expect(scoreOcrText(useful).good).toBe(false);
    expect(parseReceiptText(result.text).receipt.items[0]).toMatchObject({ lineTotalCents: null, flagged: true });
    expect(worker.terminate).toHaveBeenCalled();
  });

  it.each([false, true])("selects a better original-colour reading only with supported quantity evidence = %s", async (quantityHeading) => {
    setup();
    // 1d retains the original unheaded reading as the negative case. Only the
    // separately headed variant satisfies the unchanged selection policy.
    const clear = `EXAMPLE CAFE\n${quantityHeading ? "Description Qty Amount\n" : ""}Iced Tea 2 6.00\nTotal (INCL GST) 6.00\nGST 0.50`;
    const worker = {
      setParameters: vi.fn().mockResolvedValue(undefined),
      recognize: vi.fn()
        .mockResolvedValueOnce({ data: { text: footer } })
        .mockResolvedValueOnce({ data: { text: useful } })
        .mockResolvedValueOnce({ data: { text: clear } }),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createWorker.mockResolvedValue(worker);
    const result = await runOcr(file, options, vi.fn(), new AbortController().signal, scoreOcrText);
    expect(result).toMatchObject({ text: quantityHeading ? clear : useful, passes: 3, selectedAttempt: quantityHeading ? 2 : 1 });
    expect(result.attempts.map(a => a.preprocessing)).toEqual(["flattened", "flattened", "original"]);
    expect(result.attempts[0]!.score).toBeNull(); // JSON-safe representation of no items
    expect(result.attempts[2]!.score).toBeGreaterThan(result.attempts[1]!.score!);
    expect(result.attempts[2]!.good).toBe(quantityHeading);
  });

  it("does not replace recovered rows with an unaccepted colour reading just for a higher score", async () => {
    setup();
    const richer = "EXAMPLE STORE\nProduct Qty Total\nCoffee 1 4.00\nFruit Muffin 1\nCheese Sandwich 1";
    const sparse = "EXAMPLE STORE\nProduct Qty Total\nCoffee 1 4.00";
    expect(scoreOcrText(sparse).score).toBeGreaterThan(scoreOcrText(richer).score);
    expect(scoreOcrText(sparse).good).toBe(false);
    const worker = {
      setParameters: vi.fn().mockResolvedValue(undefined),
      recognize: vi.fn()
        .mockResolvedValueOnce({ data: { text: richer } })
        .mockResolvedValueOnce({ data: { text: richer } })
        .mockResolvedValueOnce({ data: { text: sparse } }),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createWorker.mockResolvedValue(worker);
    const result = await runOcr(file, options, vi.fn(), new AbortController().signal, scoreOcrText);
    expect(result).toMatchObject({ text: richer, passes: 3, selectedAttempt: 0 });
    expect(result.attempts[2]!.text).toBe(sparse);
  });

  it("allows an uncertain colour reading to rescue two footer-only readings", async () => {
    setup();
    const worker = {
      setParameters: vi.fn().mockResolvedValue(undefined),
      recognize: vi.fn()
        .mockResolvedValueOnce({ data: { text: footer } })
        .mockResolvedValueOnce({ data: { text: footer } })
        .mockResolvedValueOnce({ data: { text: useful } }),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createWorker.mockResolvedValue(worker);
    const result = await runOcr(file, options, vi.fn(), new AbortController().signal, scoreOcrText);
    expect(result).toMatchObject({ text: useful, passes: 3, selectedAttempt: 2 });
    expect(parseReceiptText(result.text).receipt.items[0]).toMatchObject({ flagged: true, lineTotalCents: null });
  });

  it("keeps the richer body and recovers only a corroborated alternate total", async () => {
    setup();
    const first = "EXAMPLE MARKET\nROLLED GRAINS 400G\n[ 4.20 V\nSALTED SPREAD 200G\n| 3.10\nPAPER BAG 1 0.10\nDENTAL PICKS 50M\n: % 230";
    const second = "EXAMPLE MARKET\nROLLED GRAINS 400G\n: 4.20 V 2\nSALTED SPREAD 200G\n: | 3.10 7\nPAPER BAG 1 0.10\nDENTAL PICKS 50M\n| 2 JNO 4\nTotal 17.40\nVISA 17.40";
    const worker = {
      setParameters: vi.fn().mockResolvedValue(undefined),
      recognize: vi.fn()
        .mockResolvedValueOnce({ data: { text: first } })
        .mockResolvedValueOnce({ data: { text: second } })
        .mockResolvedValueOnce({ data: { text: footer } }),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createWorker.mockResolvedValue(worker);
    const result = await runOcr(file, options, vi.fn(), new AbortController().signal, scoreOcrText);
    expect(result).toMatchObject({ text: first, passes: 3, selectedAttempt: 0 });
    const parsed = parseOcrResult(result).receipt;
    expect(parsed.items.map(i => i.lineTotalCents)).toEqual([420, 310, 10, null]);
    // 1d: PAPER BAG's unheaded trailing 1 is now unresolved too.
    expect(parsed.items.filter(i => i.flagged)).toHaveLength(4);
    expect(parsed.items[2]).toMatchObject({ description: "PAPER BAG 1", quantityExact: null, lineTotalCents: 10 });
    expect(parsed.receiptTotalCents).toBe(1740);
    expect(parsed.rawOcrText).toBe(first);
    expect(scoreOcrText(second).good).toBe(false);
  });

  it("keeps ties and leaves unresolved values flagged", async () => {
    setup();
    const worker = { setParameters: vi.fn().mockResolvedValue(undefined), recognize: vi.fn().mockResolvedValue({ data: { text: useful } }), terminate: vi.fn().mockResolvedValue(undefined) };
    mocks.createWorker.mockResolvedValue(worker);
    const result = await runOcr(file, options, vi.fn(), new AbortController().signal, scoreOcrText);
    expect(result.selectedAttempt).toBe(0);
    expect(parseReceiptText(result.text).receipt.items[0]).toMatchObject({ flagged: true, lineTotalCents: null });
  });

  it("skips additional image variants when the first reading is accepted", async () => {
    const bitmap = setup();
    const worker = { setParameters: vi.fn().mockResolvedValue(undefined), recognize: vi.fn().mockResolvedValue({ data: { text: "Accepted text" } }), terminate: vi.fn().mockResolvedValue(undefined) };
    mocks.createWorker.mockResolvedValue(worker);
    const result = await runOcr(file, options, vi.fn(), new AbortController().signal, scorer);
    expect(result.passes).toBe(1);
    expect(worker.recognize).toHaveBeenCalledOnce();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});

describe("OCR resource cleanup", () => {
  it("does not start decoding for an already cancelled scan", async () => {
    setup();
    const ctrl = new AbortController(); ctrl.abort();
    await expect(runOcr(file, options, vi.fn(), ctrl.signal, scorer)).rejects.toBeInstanceOf(OcrCancelled);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("closes a bitmap that arrives after cancellation during decoding", async () => {
    setup();
    let resolve!: (bitmap: ImageBitmap) => void;
    vi.mocked(createImageBitmap).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const ctrl = new AbortController();
    const scan = runOcr(file, options, vi.fn(), ctrl.signal, scorer);
    const failure = expect(scan).rejects.toBeInstanceOf(OcrCancelled);
    ctrl.abort(); await failure;
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    resolve(bitmap); await tick();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("terminates a worker that finishes loading after the load timeout", async () => {
    setup();
    let resolve!: (worker: unknown) => void;
    mocks.createWorker.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const progress = vi.fn();
    const scan = runOcr(file, options, progress, new AbortController().signal, scorer);
    const failure = expect(scan).rejects.toMatchObject({ stage: "load" });
    await tick();
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    await failure;
    const count = progress.mock.calls.length;
    const worker = { terminate: vi.fn().mockResolvedValue(undefined) };
    resolve(worker); await tick();
    expect(worker.terminate).toHaveBeenCalled();
    expect(progress).toHaveBeenCalledTimes(count);
  });

  it("cancels a recognition in progress and releases its worker", async () => {
    setup();
    const worker = { setParameters: vi.fn().mockResolvedValue(undefined), recognize: vi.fn(() => new Promise(() => {})), terminate: vi.fn().mockResolvedValue(undefined) };
    mocks.createWorker.mockResolvedValue(worker);
    const ctrl = new AbortController();
    const scan = runOcr(file, options, vi.fn(), ctrl.signal, scorer);
    const failure = expect(scan).rejects.toBeInstanceOf(OcrCancelled);
    await tick(); expect(worker.recognize).toHaveBeenCalledOnce();
    ctrl.abort(); await failure;
    expect(worker.terminate).toHaveBeenCalled();
  });
});
