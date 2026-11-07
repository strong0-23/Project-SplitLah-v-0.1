import { describe, expect, it } from "vitest";
import { emptyReceipt } from "./defaults";
import { makeEvidence } from "./receipt-quality";
import { confirmPrintedChargeFields, eligiblePrintedChargeConfirmations } from "./review-confirmation";
import type { Receipt } from "./types";

function receipt(): Receipt {
  return { ...emptyReceipt(), chargeMode: "receipt", serviceEnabled: true, serviceAmountCents: 100,
    gstEnabled: true, gstAmountCents: 90, gstInclusive: true,
    evidence: {
      service: makeEvidence("observed", [{ kind: "text", engine: "text", lineIndices: [3], text: "Service charge 1.00" }]),
      gst: makeEvidence("observed", [{ kind: "geometry", engine: "paddle", boxIndices: [9], text: "GST included 0.90" }]),
      gstInclusive: makeEvidence("observed", [{ kind: "text", text: "GST included 0.90" }]),
    } };
}
const fields = (value: Receipt) => eligiblePrintedChargeConfirmations(value).map(candidate => candidate.field);

describe("printed-evidence bulk confirmation", () => {
  it("lists each independently printed amount and explicit GST treatment", () => {
    expect(fields(receipt())).toEqual(["service", "gst", "gstInclusive"]);
  });
  it("confirms only selected fields, preserves their sources and counts field actions separately", () => {
    const original = receipt();
    const result = confirmPrintedChargeFields(original, ["service", "gst", "service"]);
    expect(result.confirmedFields).toEqual(["service", "gst"]);
    expect(result.fieldActions).toBe(2);
    expect(result.receipt.evidence?.service?.sources[0]).toEqual(original.evidence?.service?.sources[0]);
    expect(result.receipt.evidence?.service?.sources.at(-1)?.kind).toBe("user");
    expect(result.receipt.evidence?.service?.previousOrigin).toBe("observed");
    expect(result.receipt.evidence?.gstInclusive).toEqual(original.evidence?.gstInclusive);
    expect(original.evidence?.service?.origin).toBe("observed");
  });
  it("excludes unknown, inferred, saved-preference, conflicting and unreadable evidence", () => {
    for (const origin of ["unknown", "inferred", "saved-preference", "defaulted"] as const) {
      const value = receipt(); value.evidence!.service = makeEvidence(origin, [{ kind: "text", text: "Service charge 1.00" }]);
      expect(fields(value)).not.toContain("service");
    }
    const value = receipt();
    value.evidence!.service = makeEvidence("observed", [{ kind: "text", text: "Service charge 1.00" }], ["Conflicting charge amount"]);
    value.evidence!.gst = makeEvidence("observed", [{ kind: "text", text: "GST ??.??" }]);
    expect(fields(value)).toEqual(["gstInclusive"]);
  });
  it("does not establish absence from missing OCR or arithmetic agreement", () => {
    const value = receipt(); value.serviceEnabled = false; value.serviceAmountCents = null;
    value.evidence!.service = makeEvidence("observed", [{ kind: "calculation", observedValue: 0, text: "Totals agree without service" }]);
    expect(fields(value)).not.toContain("service");
    value.evidence!.service = makeEvidence("observed", [{ kind: "text", text: "No service charge" }]);
    expect(fields(value)).toContain("service");
  });
  it("excludes conflicting amounts and signs rather than selecting a convenient reading", () => {
    const value = receipt(); value.evidence!.service = makeEvidence("observed", [
      { kind: "text", text: "Service charge 1.00" }, { kind: "text", text: "Service charge 2.00" },
    ]);
    expect(fields(value)).not.toContain("service");
    for (const text of ["Service charge -1.00", "Service charge \u22121.00", "Service charge 1.00-", "No service charge 1.00"]) {
      value.evidence!.service = makeEvidence("observed", [{ kind: "text", text }]);
      expect(fields(value)).not.toContain("service");
    }
    value.serviceEnabled = false;
    value.evidence!.service = makeEvidence("observed", [{ kind: "text", text: "No service charge 10%" }]);
    expect(fields(value)).not.toContain("service");
  });
  it("does not confirm conflicting included/added statements or an amount associated only with another charge", () => {
    const value = receipt();
    value.evidence!.gstInclusive = makeEvidence("observed", [{ kind: "text", text: "GST included" }, { kind: "text", text: "GST added" }]);
    value.evidence!.service = makeEvidence("observed", [{ kind: "text", text: "GST 1.00" }]);
    expect(fields(value)).toEqual(["gst"]);
  });
  it("checks applicable rates separately from charge presence and excludes stale selected fields", () => {
    const value = receipt(); value.chargeMode = "percentage"; value.serviceRateBp = 1000;
    value.evidence!.service = makeEvidence("observed", [{ kind: "text", text: "Service charge 10% 1.00" }]);
    value.evidence!.serviceRateBp = makeEvidence("observed", [{ kind: "text", text: "Service charge 10% 1.00" }]);
    expect(fields(value)).toContain("serviceRateBp");
    value.evidence!.serviceRateBp.needsReview = true;
    const result = confirmPrintedChargeFields(value, ["serviceRateBp", "currency"]);
    expect(result.fieldActions).toBe(0);
    expect(result.receipt).toBe(value);
  });
  it("excludes product names and non-financial service text even when a value matches", () => {
    for (const text of ["GST FREE COLA 0.90", "Cola GST 0.90", "GST included cola 0.90", "GST 0.90 souvenir"]) {
      const value = receipt();
      value.evidence!.gst = makeEvidence("observed", [{ kind: "text", text }]);
      value.evidence!.gstInclusive = makeEvidence("observed", [{ kind: "text", text }]);
      expect(fields(value)).not.toContain("gst");
      expect(fields(value)).not.toContain("gstInclusive");
    }
    for (const text of ["Service charge mug 1.00", "Customer service voucher 1.00", "Service 1.00 token", "Service charge waived mug 1.00"]) {
      const value = receipt(); value.evidence!.service = makeEvidence("observed", [{ kind: "text", text }]);
      expect(fields(value)).not.toContain("service");
    }
    const percentage = { ...receipt(), chargeMode: "percentage" as const, gstRateBp: 900 };
    percentage.evidence!.gst = makeEvidence("observed", [{ kind: "text", text: "GST FREE COLA 9%" }]);
    percentage.evidence!.gstRateBp = percentage.evidence!.gst;
    expect(fields(percentage)).not.toContain("gst");
    expect(fields(percentage)).not.toContain("gstRateBp");
  });
  it("allows supported currency, rate and treatment decorations around a complete financial label", () => {
    const value = receipt();
    value.evidence!.service = makeEvidence("observed", [{ kind: "text", text: "Service charge (10%): SGD 1.00" }]);
    value.evidence!.gst = makeEvidence("observed", [{ kind: "text", text: "GST included (9%): S$ 0.90" }]);
    value.evidence!.gstInclusive = makeEvidence("observed", [{ kind: "text", text: "Prices already include GST" }]);
    expect(fields(value)).toEqual(["service", "gst", "gstInclusive"]);
    value.evidence!.gst!.sources.push({ kind: "text", text: "GST FREE COLA 0.90" });
    expect(fields(value)).not.toContain("gst");
  });
});
