import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BillProvider, useBill } from "@/hooks/use-bill";
import { parseRecognitionDocument } from "@/lib/recognition-parser";
import { documentFromTesseract } from "@/lib/recognition-document";
import { confirmItemField, confirmReceiptField, makeEvidence, rowReviewState } from "@/lib/receipt-quality";
import { assessReceipt } from "@/lib/receipt-status";
import { loadSession, saveSession } from "@/lib/storage";
import { calculateBill, computeTotals } from "@/lib/bill";
import type { OcrResult } from "@/lib/ocr";
import type { Receipt } from "@/lib/types";
import { ReviewStep } from "./ReviewStep";

const source = "SYNTHETIC SHOP\n1 x Synthetic beverage 10.00\nCash rounding -0.10\nTOTAL 9.90";
let current: Receipt;
function Probe() { current = useBill().receipt; return null; }
function productionReceipt(text = source, uncertainLines: number[] = []): Receipt {
  const document = documentFromTesseract({ text, selectedAttempt: 0, attempts: [{ text }] } as OcrResult);
  uncertainLines.forEach(index => { document.lines[index]!.uncertain = true; });
  let receipt = parseRecognitionDocument(document).receipt;
  receipt.items = receipt.items.map(item => ["description", "quantity", "lineTotalCents", "role"]
    .reduce((value, field) => confirmItemField(value, field as "description" | "quantity" | "lineTotalCents" | "role"), item));
  for (const field of ["currency", "discountCents", "service", "gst", "gstInclusive", "total"] as const)
    receipt = confirmReceiptField(receipt, field);
  return receipt;
}
async function mount(receipt: Receipt) {
  expect(saveSession({ receipt, participants: [], assignments: {} })).toBe(true);
  render(<BillProvider><Probe /><ReviewStep go={() => undefined} /></BillProvider>);
  await waitFor(() => expect(current.rawOcrText).toBe(receipt.rawOcrText));
}
beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("Batch 1d rounding Review production flow", () => {
  it("reaches Ready after applying the only unresolved rounding issue through the actual control", async () => {
    const receipt = productionReceipt();
    expect(receipt.evidence?.rounding?.sources[0]).toMatchObject({ engine: "tesseract", attemptIndex: 0, lineIndices: [2] });
    expect(receipt.evidence?.rows?.needsReview).toBe(true);
    await mount(receipt);
    fireEvent.click(screen.getByRole("button", { name: "I checked this rounding amount; apply it once" }));
    expect(current.roundingApplied).toBe(true);
    expect(current.rows?.every(row => !row.needsReview && row.role !== "ambiguous")).toBe(true);
    expect(screen.queryByText("Receipt rows needing a check")).not.toBeInTheDocument();
    expect(current.evidence?.rows?.needsReview).toBe(false);
    expect(assessReceipt(current)).toMatchObject({ status: "Ready", reasons: [] });
    expect(screen.getByRole("button", { name: "Continue to split" })).toBeEnabled();
    expect(current.evidence?.rounding).toMatchObject({ origin: "user-confirmed", previousOrigin: "observed", needsReview: false });
    expect(current.rows?.find(row => row.role === "rounding")).toMatchObject({ amountCents: -10, text: "Cash rounding -0.10" });
    expect(current.evidence?.rounding?.sources[0]).toEqual(receipt.evidence?.rounding?.sources[0]);
    expect(current.evidence?.rounding?.sources.at(-1)).toMatchObject({ kind: "user", observedValue: -10 });
  });

  it("preserves another ambiguous row and its actual resolution control", async () => {
    const text = "SYNTHETIC SHOP\nDescription Qty Amount\nPOSSIBLE PRODUCT\nSynthetic beverage 1 10.00\nCash rounding -0.10\nTOTAL 9.90";
    await mount(productionReceipt(text));
    const pending = current.rows!.find(row => row.text === "POSSIBLE PRODUCT")!;
    expect(pending.role).toBe("ambiguous");
    fireEvent.click(screen.getByRole("button", { name: "I checked this rounding amount; apply it once" }));
    expect(current.rows!.find(row => row.id === pending.id)).toEqual(pending);
    expect(screen.getByLabelText("Confirm this row's role")).toBeInTheDocument();
    expect(assessReceipt(current).reasons.some(reason => reason.path === "rows")).toBe(true);
    fireEvent.change(screen.getByLabelText("Confirm this row's role"), { target: { value: "heading" } });
    expect(assessReceipt(current).status).toBe("Ready");
    expect(screen.queryByText("Receipt rows needing a check")).not.toBeInTheDocument();
  });

  it("preserves independent bound source uncertainty until its visible confirmation is used", async () => {
    const text = "SYNTHETIC SHOP\nDescription Qty Amount\nPOSSIBLE PRODUCT\nSynthetic beverage 1 10.00\nCash rounding -0.10\nTOTAL 9.90";
    await mount(productionReceipt(text, [2]));
    expect(rowReviewState(current).independentNeedsReview).toBe(true);
    const sources = structuredClone(current.evidence!.rows!.sources);
    fireEvent.click(screen.getByRole("button", { name: "I checked this rounding amount; apply it once" }));
    expect(screen.getByRole("button", { name: "I checked the retained row evidence" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Confirm this row's role"), { target: { value: "heading" } });
    expect(screen.queryByText("Receipt rows needing a check")).not.toBeInTheDocument();
    expect(current.evidence?.rows?.needsReview).toBe(true);
    expect(current.evidence?.rows?.reasons).toContain("Recognition layout/source association needs checking.");
    expect(current.evidence?.rows?.sources).toEqual(sources);
    expect(assessReceipt(current).reasons.map(reason => reason.path)).toEqual(["rows"]);
    fireEvent.click(screen.getByRole("button", { name: "I checked the retained row evidence" }));
    expect(assessReceipt(current).status).toBe("Ready");
    expect(current.evidence?.rows?.sources.slice(0, -1)).toEqual(sources);
    expect(current.evidence?.rows?.sources.at(-1)?.kind).toBe("user");
  });

  it.each(["Cash rounding -0.10\nCash rounding -0.10", "Cash rounding -0.10\nCash rounding +0.10"])("requires explicit input and application for repeated or conflicting rounding: %s", async rows => {
    await mount(productionReceipt(`SYNTHETIC SHOP\n1 x Synthetic beverage 10.00\n${rows}\nTOTAL 9.90`));
    expect(current.roundingAdjustmentCents).toBeNull();
    expect(screen.queryByRole("button", { name: "I checked this rounding amount; apply it once" })).not.toBeInTheDocument();
    expect(current.rows!.filter(row => row.role === "rounding").every(row => row.needsReview)).toBe(true);
    fireEvent.change(screen.getByLabelText(/Bill rounding adjustment/), { target: { value: "-0.10" } });
    expect(current.roundingApplied).toBe(false);
    expect(current.evidence?.rounding?.needsReview).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "I checked this rounding amount; apply it once" }));
    expect(current.rows!.filter(row => row.role === "rounding").every(row => !row.needsReview)).toBe(true);
    expect(current.evidence?.rounding?.sources.filter(source => source.kind === "text")).toHaveLength(2);
    expect(assessReceipt(current).status).toBe("Ready");
  });

  it.each(["", "invalid", "0.001"])("cannot apply cleared/invalid input %j or treat it as confirmed zero", async value => {
    await mount(productionReceipt());
    fireEvent.change(screen.getByLabelText(/Bill rounding adjustment/), { target: { value } });
    expect(current.roundingAdjustmentCents).toBeNull();
    expect(current.roundingApplied).toBe(false);
    expect(current.evidence?.rounding?.needsReview).toBe(true);
    expect(screen.queryByRole("button", { name: "I checked this rounding amount; apply it once" })).not.toBeInTheDocument();
    expect(assessReceipt(current).status).toBe("Needs check");
    expect(current.rows!.find(row => row.role === "rounding")!.needsReview).toBe(true);
  });

  it("retains explicit checked zero and does not bypass total reconciliation", async () => {
    await mount(productionReceipt());
    fireEvent.change(screen.getByLabelText(/Bill rounding adjustment/), { target: { value: "0.00" } });
    fireEvent.click(screen.getByRole("button", { name: "I checked this rounding amount; apply it once" }));
    expect(current).toMatchObject({ roundingAdjustmentCents: 0, roundingApplied: true });
    expect(current.evidence?.rounding).toMatchObject({ origin: "user-confirmed", needsReview: false });
    expect(assessReceipt(current).reasons).toEqual([expect.objectContaining({ path: "total", code: "reconciliation" })]);
    expect(screen.getByRole("button", { name: "Continue to split" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Receipt total/), { target: { value: "10.00" } });
    expect(assessReceipt(current).status).toBe("Ready");
  });

  it("preserves an unrelated currency blocker and exposes its existing confirmation control", async () => {
    const receipt = productionReceipt();
    receipt.evidence!.currency = makeEvidence("unknown", [], ["Currency not independently checked."]);
    await mount(receipt);
    fireEvent.click(screen.getByRole("button", { name: "I checked this rounding amount; apply it once" }));
    expect(assessReceipt(current).reasons.map(reason => reason.path)).toEqual(["currency"]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm currency SGD" }));
    expect(assessReceipt(current).status).toBe("Ready");
  });

  it("preserves GST and conserves signed cents across participant allocations after the UI action", async () => {
    await mount(productionReceipt("SYNTHETIC SHOP\n1 x Synthetic beverage 10.00\nGST 9% 0.90\nCash rounding -0.10\nTOTAL 10.80"));
    const before = computeTotals(current);
    if (!before.ok) throw new Error("Synthetic pre-application calculation failed.");
    fireEvent.click(screen.getByRole("button", { name: "I checked this rounding amount; apply it once" }));
    const itemId = current.items[0]!.id;
    const result = calculateBill(current, [{ id: "b", name: "B" }, { id: "a", name: "A" }, { id: "c", name: "C" }], {
      [itemId]: { itemId, mode: "even", participantIds: ["a", "b", "c"], quantities: {}, amounts: {} },
    });
    if (!result.ok) throw new Error(result.errors.join(" "));
    expect(result.value.totals.gstAddedCents).toBe(before.value.gstAddedCents);
    expect(result.value.totals.gstAddedCents).toBe(90);
    expect(result.value.totals.unroundedTotalCents).toBe(1090);
    expect(result.value.participants.reduce((sum, participant) => sum + (participant.roundingCents ?? 0), 0)).toBe(-10);
    expect(result.value.participants.reduce((sum, participant) => sum + participant.owedCents, 0)).toBe(1080);
    expect(assessReceipt(current).status).toBe("Ready");
  });

  it("does not reintroduce the resolved rounding blocker after save/load and a second real Review mount", async () => {
    await mount(productionReceipt());
    fireEvent.click(screen.getByRole("button", { name: "I checked this rounding amount; apply it once" }));
    const resolved = structuredClone(current);
    expect(saveSession({ receipt: resolved, participants: [], assignments: {} })).toBe(true);
    const loaded = loadSession();
    if (loaded.status !== "ok") throw new Error("Synthetic state failed to load.");
    expect(loaded.session.receipt).toEqual(resolved);
    cleanup();
    await mount(loaded.session.receipt);
    expect(assessReceipt(current).status).toBe("Ready");
    expect(screen.getByRole("button", { name: "Continue to split" })).toBeEnabled();
    expect(screen.queryByText("Receipt rows needing a check")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "I checked this rounding amount; apply it once" })).not.toBeInTheDocument();
  });
});
