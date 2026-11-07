import { beforeEach, expect, it } from "vitest";
import { parseReceiptText } from "./parser";
import { loadSession, saveSession } from "./storage";
import { applySavedPreferences } from "./preferences";
import { eligibleQuantityDefaults } from "./quantity-defaults";

beforeEach(() => localStorage.clear());
it("persists signed rounding and separate unambiguous row/evidence", () => {
  const receipt = parseReceiptText("SHOP\nProduct Qty Total\nCOFFEE 1 3.02\nCash rounding -0.02\nTotal 3.00").receipt;
  expect(saveSession({receipt,participants:[],assignments:{}})).toBe(true);
  const loaded = loadSession();expect(loaded.status).toBe("ok");if(loaded.status!=="ok")return;
  expect(loaded.session.receipt).toMatchObject({roundingApplied:true,roundingAdjustmentCents:-2,evidence:{rounding:{origin:"observed",needsReview:false}}});
  expect(loaded.session.receipt.rows!.some(row=>row.role==="rounding"&&row.amountCents===-2)).toBe(true);
});
it("persists saved-preference origin and one-off optional prompt marker without confirming applicability", () => {
  const receipt = applySavedPreferences(parseReceiptText("SHOP\nCOFFEE 3.00\nTotal 3.00").receipt,{schemaVersion:1,currency:{value:"SGD",confirmedAt:"2026-10-24T00:00:00Z"}});
  receipt.preferencePromptHandled=true;
  expect(saveSession({receipt,participants:[],assignments:{}})).toBe(true);
  const loaded=loadSession();expect(loaded.status).toBe("ok");if(loaded.status!=="ok")return;
  expect(loaded.session.receipt).toMatchObject({preferencePromptHandled:true,evidence:{currency:{origin:"saved-preference",needsReview:true,sources:[{kind:"preference"}]}}});
});
it("preserves positive layout support while defaults remain pending", () => {
  const receipt=parseReceiptText("SHOP\nDescription         Amount\nCOFFEE              3.00\nMUFFIN              2.00\nTotal               5.00").receipt;
  expect(eligibleQuantityDefaults(receipt)).toHaveLength(2);
  expect(saveSession({receipt,participants:[],assignments:{}})).toBe(true);
  const loaded=loadSession();if(loaded.status!=="ok")throw new Error("Could not reload synthetic session");
  expect(eligibleQuantityDefaults(loaded.session.receipt)).toHaveLength(2);
  expect(loaded.session.receipt.items.every(item=>item.evidence!.quantity!.origin==="defaulted"&&item.evidence!.quantity!.needsReview)).toBe(true);
});
