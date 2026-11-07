import { describe, expect, it } from "vitest";
import { emptyReceipt } from "./defaults";
import { confirmReceiptField, makeEvidence } from "./receipt-quality";
import { applySavedPreferences, eligiblePreferenceValues, loadSavedPreferences, mergeConfirmedPreferences, PREFERENCES_KEY, savedPreferenceConflicts, writeSavedPreferences } from "./preferences";
import type { PreferenceStorage, SavedPreferences } from "./preferences";

const date = "2026-10-24T00:00:00.000Z";
const saved: SavedPreferences = { schemaVersion: 1, currency: { value: "SGD", confirmedAt: date },
  gstRateBp: { value: 900, confirmedAt: date }, serviceRateBp: { value: 1000, confirmedAt: date } };
const memory = () => {
  const values = new Map<string, string>();
  const storage: PreferenceStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  return { values, storage };
};

describe("explicit saved receipt preferences", () => {
  it("confirming currency cannot save untouched rate defaults", () => {
    const value = confirmReceiptField(emptyReceipt(), "currency");
    expect(eligiblePreferenceValues(value).map(candidate => candidate.key)).toEqual(["currency"]);
    const result = mergeConfirmedPreferences(value, ["currency", "gstRateBp", "serviceRateBp"], null, date);
    expect(result.savedKeys).toEqual(["currency"]);
    expect(result.preferences).toEqual({ schemaVersion: 1, currency: saved.currency });
  });
  it("requires a user confirmation of the present field value, not a stale or unrelated confirmation", () => {
    let value = confirmReceiptField(emptyReceipt(), "gstRateBp");
    value = { ...value, gstRateBp: 800 };
    expect(eligiblePreferenceValues(value)).toEqual([]);
    value.evidence!.gstRateBp = makeEvidence("user-confirmed", [{ kind: "user", observedValue: "SGD" }]);
    expect(eligiblePreferenceValues(value)).toEqual([]);
  });
  it("allows each separately confirmed rate and saves selected values without changing existing preferences", () => {
    const value = confirmReceiptField(confirmReceiptField(emptyReceipt(), "gstRateBp"), "serviceRateBp");
    const result = mergeConfirmedPreferences(value, ["gstRateBp"], { schemaVersion: 1, currency: saved.currency! }, date);
    expect(result.savedKeys).toEqual(["gstRateBp"]);
    expect(result.preferences.currency).toEqual(saved.currency);
    expect(result.preferences.serviceRateBp).toBeUndefined();
  });
  it("prefills settings only, labels their source and leaves presence, amounts, mode and GST treatment untouched", () => {
    const value = emptyReceipt();
    const next = applySavedPreferences(value, saved);
    expect(next.evidence?.gstRateBp?.origin).toBe("saved-preference");
    expect(next.evidence?.gstRateBp?.needsReview).toBe(true);
    expect(next.evidence?.gstRateBp?.sources[0]?.kind).toBe("preference");
    for (const key of ["serviceEnabled", "gstEnabled", "serviceAmountCents", "gstAmountCents", "chargeMode", "gstInclusive"] as const)
      expect(next[key]).toBe(value[key]);
    expect(next.evidence?.service).toEqual(value.evidence?.service);
    expect(next.evidence?.gst).toEqual(value.evidence?.gst);
    expect(next.evidence?.gstInclusive).toEqual(value.evidence?.gstInclusive);
  });
  it("never overwrites observed, inferred, user-confirmed or conflicting receipt settings", () => {
    for (const origin of ["observed", "inferred", "user-confirmed", "unknown", "defaulted"] as const) {
      const value = { ...emptyReceipt(), gstRateBp: 800 };
      value.evidence!.gstRateBp = makeEvidence(origin, [{ kind: "text", text: "GST 8% or unreadable conflicting tax text" }]);
      expect(applySavedPreferences(value, saved).gstRateBp).toBe(800);
      const next = applySavedPreferences(value, saved);
      expect(next.evidence?.gstRateBp?.origin).toBe(origin);
      expect(next.evidence?.gstRateBp?.sources[0]).toEqual(value.evidence!.gstRateBp?.sources[0]);
      if (origin === "observed" || origin === "inferred") {
        expect(next.evidence?.gstRateBp?.needsReview).toBe(true);
        expect(savedPreferenceConflicts(next)).toMatchObject([{ key: "gstRateBp", receiptValue: 800, savedValue: 900 }]);
      } else expect(next.evidence?.gstRateBp).toEqual(value.evidence!.gstRateBp);
    }
  });
  it("flags an observed rate conflicting with saved defaults without changing extraction, and resolves only after individual confirmation", () => {
    const value = { ...emptyReceipt(), chargeMode: "receipt" as const, gstRateBp: 900 };
    value.evidence!.gstRateBp = makeEvidence("observed", [{ kind: "text", text: "GST 9%", observedValue: 900 }]);
    const defaults = { schemaVersion: 1 as const, gstRateBp: { value: 800, confirmedAt: date } };
    const next = applySavedPreferences(value, defaults);
    expect(next.gstRateBp).toBe(900);
    expect(next.evidence?.gstRateBp?.origin).toBe("observed");
    expect(next.evidence?.gstRateBp?.needsReview).toBe(true);
    expect(next.evidence?.gstRateBp?.sources[0]).toEqual(value.evidence!.gstRateBp.sources[0]);
    expect(next.evidence?.gstRateBp?.sources.at(-1)).toMatchObject({ kind: "preference", observedValue: 800 });
    expect(savedPreferenceConflicts(next)).toMatchObject([{ key: "gstRateBp", receiptValueLabel: "9%", savedValueLabel: "8%" }]);
    const confirmed = confirmReceiptField(next, "gstRateBp");
    expect(confirmed.gstRateBp).toBe(900);
    expect(savedPreferenceConflicts(confirmed)).toEqual([]);
    expect(confirmed.evidence?.gstRateBp?.sources).toEqual(expect.arrayContaining(next.evidence!.gstRateBp!.sources));
    expect(confirmed.evidence?.gstRateBp?.sources.at(-1)).toMatchObject({ kind: "user", observedValue: 900 });
    expect(applySavedPreferences(confirmed, defaults)).toEqual(confirmed);
  });
  it("does not turn a saved rate into evidence that the current receipt uses it", () => {
    const value = applySavedPreferences(emptyReceipt(), saved);
    expect(eligiblePreferenceValues(value)).toEqual([]);
    expect(value.evidence?.gstRateBp?.needsReview).toBe(true);
    const checked = confirmReceiptField(value, "gstRateBp");
    expect(checked.evidence?.gstRateBp?.previousOrigin).toBe("saved-preference");
    expect(eligiblePreferenceValues(checked).map(candidate => candidate.key)).toEqual(["gstRateBp"]);
    expect(checked.evidence?.gstRateBp?.sources.some(source => source.kind === "preference")).toBe(true);
  });
  it("persists only an allowlisted separate schema and ignores receipt images and source content", () => {
    const store = memory();
    const polluted = { ...saved, image: "synthetic-private-image", receiptText: "synthetic-private-text", gstAmountCents: 123 };
    expect(writeSavedPreferences(polluted, store.storage)).toBe(true);
    const text = store.values.get(PREFERENCES_KEY)!;
    expect(text).not.toContain("synthetic-private");
    expect(text).not.toContain("gstAmountCents");
    expect(loadSavedPreferences(store.storage)).toEqual(saved);
    expect([...store.values.keys()]).toEqual([PREFERENCES_KEY]);
  });
  it("handles unavailable, malformed and unsupported storage without blocking review", () => {
    expect(writeSavedPreferences(saved, null)).toBe(false);
    expect(loadSavedPreferences(null)).toBeNull();
    const store = memory();
    for (const text of ["broken", '{"schemaVersion":2}', '{"schemaVersion":1,"gstRateBp":{"value":-1,"confirmedAt":"bad"}}']) {
      store.values.set(PREFERENCES_KEY, text);
      expect(loadSavedPreferences(store.storage)?.gstRateBp).toBeUndefined();
    }
  });
});
