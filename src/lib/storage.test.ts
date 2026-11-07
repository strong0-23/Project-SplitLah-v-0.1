import { beforeEach, describe, expect, it } from "vitest";
import { emptyReceipt } from "./defaults";
import { loadSession, saveSession, SCHEMA_VERSION, STORAGE_KEY } from "./storage";
import { confirmItemField, makeEvidence } from "./receipt-quality";

beforeEach(() => window.localStorage.clear());
describe("schema-v2 provenance persistence", () => {
  it("round-trips explicit unknown quantity and recovered source evidence", () => {
    const receipt = emptyReceipt();
    receipt.items = [
      {
        id: "item",
        description: "SYNTHETIC PRODUCT",
        quantity: 1,
        quantityExact: null,
        lineTotalCents: 520,
        flagged: true,
        evidence: {
          quantity: makeEvidence("unknown", [
            { kind: "text", text: "unreadable quantity", lineIndices: [2] },
          ]),
          lineTotalCents: makeEvidence(
            "observed",
            [
              {
                kind: "geometry",
                engine: "tesseract",
                attemptIndex: 1,
                boxIndices: [4],
                observedValue: 520,
              },
            ],
            ["Closer scan requires confirmation"],
          ),
        },
      },
    ];
    expect(saveSession({ receipt, participants: [], assignments: {} })).toBe(true);
    const loaded = loadSession();
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") expect(loaded.session.receipt.items[0]).toEqual(receipt.items[0]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).version).toBe(SCHEMA_VERSION);
  });
  it("migrates v1 data without claiming old values were observed or confirmed", () => {
    const receipt = emptyReceipt();
    delete receipt.evidence;
    receipt.items = [
      { id: "item", description: "LEGACY SYNTHETIC", quantity: 2, lineTotalCents: 800 },
    ];
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, receipt, participants: [], assignments: {} }),
    );
    const loaded = loadSession();
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.session.receipt.items[0]).toMatchObject({
        quantity: 2,
        quantityExact: null,
        lineTotalCents: 800,
        flagged: true,
        evidence: { quantity: { origin: "unknown", needsReview: true } },
      });
      expect(loaded.session.receipt.evidence?.currency?.origin).toBe("unknown");
    }
  });
  it("preserves exact fractional returns and signed custom allocations", () => {
    const receipt = emptyReceipt();
    receipt.items = [
      {
        id: "item",
        description: "RETURN SYNTHETIC",
        quantity: 0.375,
        quantityExact: { numerator: 3, denominator: 8 },
        rowKind: "return",
        lineTotalCents: -150,
      },
    ];
    expect(
      saveSession({
        receipt,
        participants: [],
        assignments: {
          item: {
            itemId: "item",
            mode: "custom",
            participantIds: [],
            quantities: {},
            amounts: { p: -150 },
          },
        },
      }),
    ).toBe(true);
    const loaded = loadSession();
    if (loaded.status !== "ok") throw new Error("Synthetic session did not load");
    expect(loaded.session.receipt.items[0]?.quantityExact).toEqual({
      numerator: 3,
      denominator: 8,
    });
    expect(loaded.session.assignments["item"]?.amounts["p"]).toBe(-150);
  });
  it("persists only the structured schema, stripping image-like extra properties", () => {
    const receipt = { ...emptyReceipt(), imageData: "synthetic-forbidden-image-payload" };
    expect(saveSession({ receipt, participants: [], assignments: {} })).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toContain(
      "synthetic-forbidden-image-payload",
    );
  });
  it("preserves long-receipt original sources when a user confirms a field", () => {
    const sources = Array.from({ length: 40 }, (_, index) => ({
      kind: "text" as const,
      engine: "text" as const,
      lineIndices: [index],
      text: `Synthetic original source ${index}`,
    }));
    const receipt = emptyReceipt();
    receipt.items = [
      confirmItemField(
        {
          id: "long-evidence-item",
          description: "Synthetic long receipt product",
          quantity: 1,
          quantityExact: { numerator: 1, denominator: 1 },
          lineTotalCents: 500,
          evidence: { description: makeEvidence("observed", sources) },
        },
        "description",
      ),
    ];
    receipt.rows = [
      {
        id: "long-evidence-row",
        role: "product",
        text: "Synthetic retained row",
        amountCents: 500,
        sources,
        needsReview: false,
      },
    ];
    expect(saveSession({ receipt, participants: [], assignments: {} })).toBe(true);
    const loaded = loadSession();
    if (loaded.status !== "ok") throw new Error("Synthetic long receipt did not load");
    const evidence = loaded.session.receipt.items[0]?.evidence?.description;
    expect(evidence?.sources.slice(0, 40)).toEqual(sources);
    expect(evidence?.sources).toHaveLength(41);
    expect(evidence?.sources[40]).toMatchObject({ kind: "user" });
    expect(evidence?.previousOrigin).toBe("observed");
    expect(loaded.session.receipt.rows?.[0]?.sources).toEqual(sources);
  });
});
