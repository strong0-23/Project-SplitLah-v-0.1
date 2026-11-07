import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { datasetSchema, expectedSchema, evaluate, compare, type Baseline } from "./model";
import { parseReceiptText } from "../../src/lib/parser";
import { scoreOcrText } from "../../src/lib/scan-score";

const example = datasetSchema.parse(JSON.parse(readFileSync("tools/receipt-regression/examples/dataset.json", "utf8")));
describe("parser-only synthetic references (no OCR)", () => {
  for (const receipt of example.receipts) it(receipt.id, () => {
    const text = readFileSync(`tools/receipt-regression/examples/${receipt.transcript}`, "utf8");
    const parsed = parseReceiptText(text).receipt;
    expect(evaluate(receipt.expected, parsed).filter((c) => c.status === "fail")).toEqual([]);
    // The parser flags short descriptions such as TEA; flagged fields now request another OCR pass.
    expect(scoreOcrText(text).good).toBe(receipt.id !== "synthetic-exclusive");
  });
});
describe("regression evaluator", () => {
  const parsed = () => parseReceiptText("Shop\nProduct Qty Total\nTEA 2 $5.00\nCAKE 1 $3.00\nTotal $8.00").receipt;
  it("never counts unknown fields as passes, including missing items", () => {
    const checks = evaluate(expectedSchema.parse({ items: [{ description: "Missing", quantity: null }] }), parsed());
    expect(checks.find((c) => c.key.endsWith(":present"))?.status).toBe("fail");
    expect(checks.find((c) => c.key.endsWith(":quantity"))?.status).toBe("unknown");
    expect(checks.filter((c) => c.status === "pass")).toHaveLength(0);
  });
  it("reports missing/extra items and quantity/line-amount deltas", () => {
    const checks = evaluate(expectedSchema.parse({ itemsComplete: true, items: [{ description: " tea ", quantity: 1, lineTotalCents: 250 }, { description: "Soup" }] }), parsed());
    expect(checks.find((c) => c.key.endsWith(":quantity"))).toMatchObject({ status: "fail", delta: 1 });
    expect(checks.find((c) => c.key.endsWith(":lineTotalCents"))).toMatchObject({ status: "fail", delta: 250 });
    expect(checks.some((c) => c.key.startsWith("extra:") && c.status === "fail")).toBe(true);
    expect(checks.find((c) => c.key === "extraItemCount")).toMatchObject({ actual: 1 });
  });
  it("matches duplicate items once each and ignores unit price for scoring", () => {
    const r = parsed(); r.items[1]!.description = "TEA";
    const checks = evaluate(expectedSchema.parse({ itemsComplete: true, items: [{ description: "TEA", lineTotalCents: 500, unitPriceCents: 250 }, { description: "TEA", lineTotalCents: 300 }] }), r);
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.find((c) => c.key.includes("unitPrice"))?.status).toBe("unknown");
  });
  it("failed scans cannot produce passes", () => {
    const checks = evaluate(example.receipts[0]!.expected, null);
    expect(checks.some((c) => c.status === "pass")).toBe(false);
    expect(checks.find((c) => c.key === "printedPayableTotalCents")?.status).toBe("fail");
  });
  it("does not score extra items against incomplete references", () => {
    expect(evaluate(expectedSchema.parse({ items: [] }), parsed()).every((c) => c.status === "unknown")).toBe(true);
  });
  it("checks explicit zero/false and keeps receipt charges scoreable when item totals are missing", () => {
    const r = parseReceiptText("Shop\nProduct Qty Total\nTEA(GST*) 2\nSubtotal $5.00\nService charge $0.50\nGST $0.50\nTotal $6.00").receipt;
    const checks = evaluate(expectedSchema.parse({ discountCents: 0, serviceChargeCents: 50, gstCents: 50, gstInclusive: false, payableTotalCents: 600 }), r);
    expect(checks.find((c) => c.key === "serviceChargeCents")?.status).toBe("pass");
    expect(checks.find((c) => c.key === "gstCents")?.status).toBe("pass");
    expect(checks.find((c) => c.key === "discountCents")?.status).toBe("pass");
    expect(checks.find((c) => c.key === "gstInclusive")?.status).toBe("pass");
    expect(checks.find((c) => c.key === "computedPayableTotalCents")?.status).toBe("fail");
  });
  it("rejects decimal cents, duplicate IDs and invalid crops", () => {
    expect(expectedSchema.safeParse({ payableTotalCents: 1.5 }).success).toBe(false);
    expect(datasetSchema.safeParse({ schemaVersion: 1, receipts: [example.receipts[0], example.receipts[0]] }).success).toBe(false);
    expect(datasetSchema.safeParse({ schemaVersion: 1, receipts: [{ ...example.receipts[0], scanOptions: { rotation: null, crop: { left: .8, right: .2, top: 0, bottom: 1 } } }] }).success).toBe(false);
  });
});
describe("baseline comparison", () => {
  const base: Baseline = { schemaVersion: 1, mode: "ocr", revision: "before", results: [{ id: "one", fingerprint: "same", error: null, checks: [{ key: "quantity", status: "pass" }, { key: "total", status: "fail" }] }] };
  it("finds improvements and regressions separately", () => {
    const changes = compare({ mode: "ocr", results: [{ ...base.results[0]!, checks: [{ key: "quantity", status: "fail" }, { key: "total", status: "pass" }] }] }, base);
    expect(changes.join("\n")).toContain("REGRESSION quantity");
    expect(changes.join("\n")).toContain("IMPROVEMENT total");
  });
  it("refuses comparisons across modes or changed input/reference", () => {
    expect(compare({ mode: "parser", results: [] }, base)[0]).toContain("Not comparable");
    expect(compare({ mode: "ocr", results: [{ ...base.results[0]!, fingerprint: "different" }] }, base)[0]).toContain("not comparable");
  });
});
