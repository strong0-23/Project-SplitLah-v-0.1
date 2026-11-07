/**
 * Harness tests (synthetic data only; no browser OCR). Ported from branch parser-v2 and adapted in
 * Batch 1b: `evaluate` takes the parser under test; added tests for silent errors and the gate.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  compare,
  datasetSchema,
  evaluate,
  expectedSchema,
  gate,
  summarise,
  summaryLine,
  type Baseline,
  type ParserUnderTest,
} from "./model";
import { parserV2, PARSERS, rework } from "./parsers";

const example = datasetSchema.parse(
  JSON.parse(readFileSync("tools/receipt-regression/examples/dataset.json", "utf8")),
);
const asAny = (p: (typeof PARSERS)[number]) => p as unknown as ParserUnderTest;

describe("parser-only synthetic references (no OCR), both parsers on the same text", () => {
  for (const receipt of example.receipts)
    for (const parser of PARSERS)
      it(`${receipt.id} — ${parser.id}`, () => {
        const text = readFileSync(
          `tools/receipt-regression/examples/${receipt.transcript}`,
          "utf8",
        );
        const p = asAny(parser);
        const checks = evaluate(receipt.expected, p.parse(text).receipt, p);
        expect(checks.filter((c) => c.status === "fail")).toEqual([]);
        expect(summarise(checks).silentErrors).toBe(0);
      });
  it("the gate passes on the synthetic examples", () => {
    for (const receipt of example.receipts) {
      const text = readFileSync(`tools/receipt-regression/examples/${receipt.transcript}`, "utf8");
      const score = (p: ParserUnderTest) =>
        summarise(evaluate(receipt.expected, p.parse(text).receipt, p));
      expect(gate(score(asAny(rework)), score(asAny(parserV2)))).toEqual([]);
    }
  });
});

describe("regression evaluator", () => {
  const parsed = () =>
    rework.parse("Shop\nProduct Qty Total\nTEA 2 $5.00\nCAKE 1 $3.00\nTotal $8.00").receipt;
  it("never counts unknown fields as passes, including missing items", () => {
    const checks = evaluate(
      expectedSchema.parse({ items: [{ description: "Missing", quantity: null }] }),
      parsed(),
      rework,
    );
    expect(checks.find((c) => c.key.endsWith(":present"))?.status).toBe("fail");
    expect(checks.find((c) => c.key.endsWith(":quantity"))?.status).toBe("unknown");
    expect(checks.filter((c) => c.status === "pass")).toHaveLength(0);
  });
  it("reports missing/extra items and quantity/line-amount deltas", () => {
    const checks = evaluate(
      expectedSchema.parse({
        itemsComplete: true,
        items: [
          { description: " tea ", quantity: 1, lineTotalCents: 250 },
          { description: "Soup" },
        ],
      }),
      parsed(),
      rework,
    );
    expect(checks.find((c) => c.key.endsWith(":quantity"))).toMatchObject({
      status: "fail",
      delta: 1,
    });
    expect(checks.find((c) => c.key.endsWith(":lineTotalCents"))).toMatchObject({
      status: "fail",
      delta: 250,
    });
    expect(checks.some((c) => c.key.startsWith("extra:") && c.status === "fail")).toBe(true);
    expect(checks.find((c) => c.key === "extraItemCount")).toMatchObject({ actual: 1 });
  });
  it("matches duplicate items once each and ignores unit price for scoring", () => {
    const r = parsed();
    r.items[1]!.description = "TEA";
    const checks = evaluate(
      expectedSchema.parse({
        itemsComplete: true,
        items: [
          { description: "TEA", lineTotalCents: 500, unitPriceCents: 250 },
          { description: "TEA", lineTotalCents: 300 },
        ],
      }),
      r,
      rework,
    );
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.find((c) => c.key.includes("unitPrice"))?.status).toBe("unknown");
  });
  it("failed scans cannot produce passes", () => {
    const checks = evaluate(example.receipts[0]!.expected, null, rework);
    expect(checks.some((c) => c.status === "pass")).toBe(false);
    expect(checks.find((c) => c.key === "printedPayableTotalCents")?.status).toBe("fail");
  });
  it("does not score extra items against incomplete references", () => {
    expect(
      evaluate(expectedSchema.parse({ items: [] }), parsed(), rework).every(
        (c) => c.status === "unknown",
      ),
    ).toBe(true);
  });
  it("checks explicit zero/false and keeps receipt charges scoreable when item totals are missing", () => {
    const r = rework.parse(
      "Shop\nProduct Qty Total\nTEA(GST*) 2\nSubtotal $5.00\nService charge $0.50\nGST $0.50\nTotal $6.00",
    ).receipt;
    const checks = evaluate(
      expectedSchema.parse({
        discountCents: 0,
        serviceChargeCents: 50,
        gstCents: 50,
        gstInclusive: false,
        payableTotalCents: 600,
      }),
      r,
      rework,
    );
    expect(checks.find((c) => c.key === "serviceChargeCents")?.status).toBe("pass");
    expect(checks.find((c) => c.key === "gstCents")?.status).toBe("pass");
    expect(checks.find((c) => c.key === "discountCents")?.status).toBe("pass");
    expect(checks.find((c) => c.key === "computedPayableTotalCents")?.status).toBe("fail");
  });
  it("rejects decimal cents, duplicate IDs and invalid crops", () => {
    expect(expectedSchema.safeParse({ payableTotalCents: 1.5 }).success).toBe(false);
    expect(
      datasetSchema.safeParse({
        schemaVersion: 1,
        receipts: [example.receipts[0], example.receipts[0]],
      }).success,
    ).toBe(false);
    expect(
      datasetSchema.safeParse({
        schemaVersion: 1,
        receipts: [
          {
            ...example.receipts[0],
            scanOptions: { rotation: null, crop: { left: 0.8, right: 0.2, top: 0, bottom: 1 } },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("does not score parser-v2's display 1 as a known quantity (quantity-evidence.test.ts)", () => {
    const r = parserV2.parse("SHOP\nSYNTHETIC 4.00\nTotal 4.00").receipt;
    expect(r.items[0]!.quantityExact).toBeNull();
    const checks = evaluate(
      {
        items: [{ description: "SYNTHETIC", quantity: 1, lineTotalCents: 400 }],
        itemsComplete: true,
      },
      r,
      parserV2,
    );
    expect(checks.find((c) => c.key.endsWith(":quantity"))).toMatchObject({
      status: "fail",
      actual: null,
    });
    expect(checks.find((c) => c.key.endsWith(":lineTotalCents"))).toMatchObject({
      status: "pass",
      actual: 400,
    });
  });
});

describe("silent errors and the merge gate", () => {
  it("counts a wrong, unflagged line amount as silent, and a flagged one as not silent", () => {
    const r = rework.parse("Shop\nProduct Qty Total\nGREEN TEA 2 $5.00\nTotal $5.00").receipt;
    expect(r.items[0]!.flagged).toBe(false);
    const want = expectedSchema.parse({
      items: [{ description: "GREEN TEA", quantity: 2, lineTotalCents: 600 }],
    });
    expect(evaluate(want, r, rework).find((c) => c.key.endsWith(":lineTotalCents"))?.silent).toBe(
      true,
    );
    r.items[0]!.flagged = true;
    expect(evaluate(want, r, rework).find((c) => c.key.endsWith(":lineTotalCents"))?.silent).toBe(
      false,
    );
  });
  it("counts a wrong total as silent only when the app claims it matches", () => {
    const r = rework.parse("Shop\nTEA 5.00\nTotal 5.00").receipt;
    const checks = evaluate(expectedSchema.parse({ payableTotalCents: 600 }), r, rework);
    expect(checks.find((c) => c.key === "computedPayableTotalCents")).toMatchObject({
      status: "fail",
      silent: true,
    });
    expect(checks.find((c) => c.key === "printedPayableTotalCents")).toMatchObject({
      status: "fail",
      silent: true,
    });
  });
  it("fails the gate on any metric where the rework is worse, and passes on ties", () => {
    const base = {
      items: { found: 3, of: 3, extra: 0 },
      quantities: { pass: 3, of: 3 },
      lineAmounts: { pass: 3, of: 3 },
      printedTotal: "pass" as const,
      calculatedTotal: "pass" as const,
      silentErrors: 0,
    };
    expect(gate(base, base)).toEqual([]);
    expect(gate({ ...base, quantities: { pass: 2, of: 3 } }, base)).toEqual(["quantities"]);
    expect(gate({ ...base, silentErrors: 1 }, base)).toEqual(["silent errors"]);
    expect(gate({ ...base, calculatedTotal: "fail" }, base)).toEqual(["calculated total"]);
    expect(gate({ ...base, items: { found: 3, of: 3, extra: 1 } }, base)).toEqual(["extra items"]);
  });
  it("summary lines carry the receipt ID and counts only", () => {
    const r = rework.parse(
      "Shop\nProduct Qty Total\nSECRET ITEM NAME 2 $5.00\nTotal $5.00",
    ).receipt;
    const s = summarise(
      evaluate(
        expectedSchema.parse({
          items: [{ description: "SECRET ITEM NAME", quantity: 2, lineTotalCents: 500 }],
          payableTotalCents: 500,
        }),
        r,
        rework,
      ),
    );
    const line = summaryLine("Receipt9", "rework", s);
    expect(line).toBe(
      "Receipt9 | rework: items 1/1; qty 1/1; amounts 1/1; printed total pass; calculated total pass; silent errors 0",
    );
    expect(line).not.toMatch(/SECRET/);
  });
});

describe("report comparison", () => {
  const base: Baseline = {
    schemaVersion: 1,
    mode: "ocr",
    revision: "before",
    results: [
      {
        id: "one",
        parser: "rework",
        fingerprint: "same",
        error: null,
        checks: [
          { key: "quantity", status: "pass" },
          { key: "total", status: "fail" },
        ],
      },
    ],
  };
  it("finds improvements and regressions separately", () => {
    const changes = compare(
      {
        mode: "ocr",
        results: [
          {
            ...base.results[0]!,
            checks: [
              { key: "quantity", status: "fail" },
              { key: "total", status: "pass" },
            ],
          },
        ],
      },
      base,
    );
    expect(changes.join("\n")).toContain("REGRESSION quantity");
    expect(changes.join("\n")).toContain("IMPROVEMENT total");
  });
  it("refuses comparisons across modes or changed input/reference", () => {
    expect(compare({ mode: "parser", results: [] }, base)[0]).toContain("Not comparable");
    expect(
      compare(
        { mode: "ocr", results: [{ ...base.results[0]!, fingerprint: "different" }] },
        base,
      )[0],
    ).toContain("not comparable");
  });
});
