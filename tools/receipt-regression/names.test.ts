/**
 * Item-name matching (owner decision, 11 Nov 2026, made before any held-out run). Synthetic,
 * invented names only; no receipt data.
 */
import { describe, expect, it } from "vitest";
import { countCorrections } from "./corrections";
import { evaluate, expectedSchema, gate, summarise, type ScoredReceipt } from "./model";
import {
  ENGINE_COMPARISON_NAME_MATCH,
  levenshtein,
  nameMatchLabel,
  nameSimilarity,
  normaliseName,
  pairNames,
  PARSER_GATE_NAME_MATCH,
  ratio,
  RECOGNISABLE_THRESHOLD,
} from "./names";

/** A receipt as the app would show it: given names, quantity 1, given amounts. */
function receipt(items: Array<[string, number]>): ScoredReceipt {
  return {
    items: items.map(([description, lineTotalCents]) => ({
      description,
      quantity: 1,
      lineTotalCents,
    })),
    discountCents: 0,
    chargeMode: "receipt",
    serviceEnabled: false,
    serviceAmountCents: null,
    gstEnabled: false,
    gstAmountCents: null,
    gstInclusive: false,
    receiptTotalCents: null,
  };
}
const parser = {
  computeTotals: () => ({ ok: false as const, errors: ["not needed"] }),
  knownQuantity: (i: ScoredReceipt["items"][number]) => i.quantity,
};
const reference = (items: Array<[string, number]>) =>
  expectedSchema.parse({
    items: items.map(([description, lineTotalCents]) => ({
      description,
      quantity: 1,
      lineTotalCents,
    })),
    itemsComplete: true,
  });

describe("normalisation and similarity", () => {
  it("case-folds, applies NFKC, strips punctuation except &, collapses spaces", () => {
    expect(normaliseName("  Fish & CHIPS!!  ")).toBe("fish & chips");
    expect(normaliseName("ＫＡＹＡ　Ｔｏａｓｔ")).toBe("kaya toast"); // full-width (NFKC)
    expect(normaliseName("Tom's  Yam-Soup (L)")).toBe("toms yam soup l");
  });
  it("drops one leading quantity token", () => {
    expect(normaliseName("1 Kaya Toast")).toBe("kaya toast");
    expect(normaliseName("2x Kaya Toast")).toBe("kaya toast");
    expect(normaliseName("2 x Kaya Toast")).toBe("kaya toast");
    expect(normaliseName("3× Kaya Toast")).toBe("kaya toast");
    expect(normaliseName("7UP")).toBe("7up"); // not a separate token
  });
  it("Levenshtein ratio = 1 − distance / max(length)", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(ratio("abcd", "abcd")).toBe(1);
    expect(ratio("abcd", "abce")).toBe(0.75);
    expect(RECOGNISABLE_THRESHOLD).toBe(0.7);
  });
  it("ignores a leading item code only when the other name lacks one", () => {
    // Without the rule, "a12 tea" vs "tea" would be 1 − 4/7 ≈ 0.43.
    expect(nameSimilarity("Tea", "A12 Tea")).toBe(1);
    expect(nameSimilarity("M5 Iced Milo", "Iced Milo")).toBe(1);
    // Both coded: the codes are compared, so neighbouring menu codes stay one edit apart.
    expect(nameSimilarity("A1 Tea", "A2 Tea")).toBeCloseTo(1 - 1 / 6);
  });
  it("compares without a bracketed note the app added after the name", () => {
    expect(nameSimilarity("Dry Noodle Bowl", "DRY NOODL BOWL (MEMBER DISC -1.00)")).toBeCloseTo(
      1 - 1 / 15,
    );
  });
});

describe("recognisable mode (engine comparison)", () => {
  it("matches a misspelled name with an item-code prefix, with 0 corrections for the name", () => {
    // Normalised "baked chickn gnocchi" vs "m5 baked chicken gnocchi": 1 − 4/24 ≈ 0.83 with the
    // code; with the lone code ignored, 1 − 1/21 ≈ 0.95.
    expect(nameSimilarity("M5 Baked Chicken Gnocchi", "Baked Chickn Gnocchi")).toBeCloseTo(
      1 - 1 / 21,
    );
    const checks = evaluate(
      reference([["M5 Baked Chicken Gnocchi", 1890]]),
      receipt([["Baked Chickn Gnocchi", 1890]]),
      parser,
      { nameMatch: "recognisable" },
    );
    expect(countCorrections(checks)).toMatchObject({ total: 0, missing: 0, extra: 0 });
    expect(checks.find((c) => c.key.endsWith(":present"))?.status).toBe("pass");
  });

  it("still checks the amount and quantity of a recognisably matched item", () => {
    const checks = evaluate(
      reference([["Baked Chicken Gnocchi", 1890]]),
      receipt([["Baked Chickn Gnocchi", 1980]]),
      parser,
      { nameMatch: "recognisable" },
    );
    expect(countCorrections(checks)).toMatchObject({ total: 1, amount: 1, missing: 0 });
    // The wrong amount on an unflagged matched item is silent, as before.
    expect(checks.find((c) => c.key.endsWith(":lineTotalCents"))?.silent).toBe(true);
  });

  it("keeps a name below 0.70 as missing + extra", () => {
    expect(nameSimilarity("Iced Lemon Tea", "Ice Kacang")).toBeLessThan(0.7);
    const checks = evaluate(
      reference([["Iced Lemon Tea", 250]]),
      receipt([["Ice Kacang", 250]]),
      parser,
      { nameMatch: "recognisable" },
    );
    expect(countCorrections(checks)).toMatchObject({ total: 2, missing: 1, extra: 1 });
  });

  it("pairs one-to-one: the closer reference item wins, the other stays missing", () => {
    const expected = ["Chicken Rice", "Chicken Rice Set"];
    const actual = ["Chicken Rice St", "Chkn Rce"];
    // Both reference items are within reach of "Chicken Rice St"; only one may have it.
    expect(nameSimilarity(expected[0]!, actual[0]!)).toBeGreaterThanOrEqual(0.7);
    expect(nameSimilarity(expected[1]!, actual[0]!)).toBeGreaterThan(
      nameSimilarity(expected[0]!, actual[0]!),
    );
    expect(nameSimilarity(expected[0]!, actual[1]!)).toBeLessThan(0.7);
    expect(pairNames(expected, actual, "recognisable")).toEqual([undefined, 0]);
    const checks = evaluate(
      reference([
        ["Chicken Rice", 500],
        ["Chicken Rice Set", 700],
      ]),
      receipt([
        ["Chicken Rice St", 700],
        ["Chkn Rce", 500],
      ]),
      parser,
      { nameMatch: "recognisable" },
    );
    expect(countCorrections(checks)).toMatchObject({ missing: 1, extra: 1, amount: 0 });
  });

  it("breaks similarity ties by printed order, never pairing one app item twice", () => {
    expect(pairNames(["Kaya Toast", "Kaya Toast"], ["Kaya Toasr"], "recognisable")).toEqual([
      0,
      undefined,
    ]);
    // Two equally close app items: the first printed one goes to the first reference item.
    expect(
      pairNames(["Kaya Toast", "Kaya Toast"], ["Kaya Toas", "Kaya Toat"], "recognisable"),
    ).toEqual([0, 1]);
  });

  it("pairs exact names first, then recognisable ones", () => {
    // "Teh Peng" would be recognisable for "Teh Pen", but its exact twin claims it first.
    expect(pairNames(["Teh Pen", "Teh Peng"], ["Teh Peng", "Teh Pem"], "recognisable")).toEqual([
      1, 0,
    ]);
  });

  it("is the engine comparison's rule, labelled recognisable-0.70", () => {
    expect(ENGINE_COMPARISON_NAME_MATCH).toBe("recognisable");
    expect(nameMatchLabel("recognisable")).toBe("recognisable-0.70");
    expect(nameMatchLabel("exact")).toBe("exact");
  });
});

describe("the Batch 1b parser gate stays exact", () => {
  it("uses the exact rule, which is also evaluate's default", () => {
    expect(PARSER_GATE_NAME_MATCH).toBe("exact");
    const ref = reference([["Baked Chicken Gnocchi", 1890]]);
    const app = receipt([["Baked Chickn Gnocchi", 1890]]);
    const byDefault = evaluate(ref, app, parser);
    expect(evaluate(ref, app, parser, { nameMatch: PARSER_GATE_NAME_MATCH })).toEqual(byDefault);
    expect(summarise(byDefault).items).toEqual({ found: 0, of: 1, extra: 1 });
    expect(countCorrections(byDefault)).toMatchObject({ missing: 1, extra: 1 });
  });

  it("keeps the original exact rule: case/space-insensitive, bracketed app note, printed order", () => {
    expect(
      pairNames(
        ["Dry Noodle", "Kopi", "Kopi"],
        ["KOPI", "dry  noodle (MEMBER DISC -1.00)", "kopi"],
        "exact",
      ),
    ).toEqual([1, 0, 2]);
    expect(pairNames(["Tea"], ["A12 Tea"], "exact")).toEqual([undefined]);
  });

  it("still counts a misspelled name against a parser in the gate", () => {
    const ref = reference([["Baked Chicken Gnocchi", 1890]]);
    const typo = summarise(evaluate(ref, receipt([["Baked Chickn Gnocchi", 1890]]), parser));
    const right = summarise(evaluate(ref, receipt([["Baked Chicken Gnocchi", 1890]]), parser));
    expect(gate(typo, right)).toEqual([
      "items found",
      "extra items",
      "quantities",
      "line amounts",
      "silent errors",
    ]);
  });
});
