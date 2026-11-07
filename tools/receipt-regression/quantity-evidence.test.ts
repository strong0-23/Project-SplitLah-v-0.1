import { expect, it } from "vitest";
import { evaluate } from "./model";
import { emptyReceipt } from "../../src/lib/defaults";
it("does not score the legacy display1 as a correct unknown quantity", () => {
  const receipt = emptyReceipt();
  receipt.items = [{ id: "synthetic", description: "SYNTHETIC", quantity: 1, quantityExact: null, lineTotalCents: 400, evidence: { quantity: { origin: "unknown", needsReview: true, reasons: [], sources: [] } } }];
  const checks = evaluate({ items: [{ description: "SYNTHETIC", quantity: 1, lineTotalCents: 400 }], itemsComplete: true }, receipt);
  expect(checks.find(c => c.key.endsWith(":quantity"))).toMatchObject({ status: "fail", actual: null });
  expect(checks.find(c => c.key.endsWith(":lineTotalCents"))).toMatchObject({ status: "pass", actual: 400 });
});
