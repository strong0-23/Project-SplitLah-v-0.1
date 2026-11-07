import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BillCtx } from "@/hooks/use-bill";
import { calculateBill, computeTotals } from "@/lib/bill";
import { makeEvidence, updateItemWithEvidence } from "@/lib/receipt-quality";
import type { ItemAssignment, Receipt, ReceiptItem } from "@/lib/types";
import { ReviewStep } from "./ReviewStep";
import { SplitStep } from "./SplitStep";

const mutableBill = vi.hoisted(() => ({ current: {} as BillCtx }));

vi.mock("@/hooks/use-bill", () => ({
  useBill: () => mutableBill.current,
  sanitizeText: (value: string, max: number) => value.slice(0, max),
  isAssigned: (assignment: ItemAssignment | undefined, personId: string) =>
    !!assignment?.participantIds.includes(personId),
}));

function confirmedReceipt(): Receipt {
  const confirmed = () =>
    makeEvidence("user-confirmed", [{ kind: "user", text: "Synthetic confirmation" }]);
  return {
    merchant: "Synthetic shop",
    currency: "SGD",
    items: [
      {
        id: "synthetic-product",
        description: "Synthetic product 500ml",
        quantity: 1,
        quantityExact: { numerator: 1, denominator: 1 },
        unitOfMeasure: "each",
        unitPriceCents: undefined,
        rowKind: "product",
        lineTotalCents: 500,
        flagged: false,
        evidence: {
          description: confirmed(),
          quantity: confirmed(),
          lineTotalCents: confirmed(),
          role: confirmed(),
        },
      },
    ],
    printedSubtotalCents: null,
    printedNetSubtotalCents: null,
    discountCents: 0,
    chargeMode: "receipt",
    serviceEnabled: false,
    serviceRateBp: 0,
    serviceAmountCents: null,
    gstEnabled: false,
    gstRateBp: 900,
    gstAmountCents: null,
    gstInclusive: false,
    receiptTotalCents: 500,
    uncertainFields: [],
    ocrWarnings: [],
    rows: [],
    evidence: {
      currency: confirmed(),
      merchant: confirmed(),
      discountCents: confirmed(),
      service: confirmed(),
      gst: confirmed(),
      serviceRateBp: confirmed(),
      gstRateBp: confirmed(),
      gstInclusive: confirmed(),
      total: confirmed(),
      rows: confirmed(),
    },
  };
}

function setBill(receipt: Receipt): void {
  mutableBill.current = {
    receipt,
    participants: [{ id: "synthetic-person", name: "Example person" }],
    assignments: {
      "synthetic-product": {
        itemId: "synthetic-product",
        mode: "single",
        participantIds: ["synthetic-person"],
        quantities: {},
        amounts: {},
      },
    },
    ready: true,
    notice: null,
    hasSession: true,
    setReceipt: vi.fn(),
    startManual: vi.fn(),
    startFromReceipt: vi.fn(),
    loadSample: vi.fn(),
    addItem: vi.fn(),
    updateItem: vi.fn((id: string, patch: Partial<ReceiptItem>) => {
      const current = mutableBill.current;
      current.receipt = {
        ...current.receipt,
        items: current.receipt.items.map((item) =>
          item.id === id ? updateItemWithEvidence(item, patch) : item,
        ),
      };
    }),
    confirmItem: vi.fn(),
    confirmReceipt: vi.fn(),
    removeItem: vi.fn(),
    addParticipant: vi.fn(),
    renameParticipant: vi.fn(),
    removeParticipant: vi.fn(),
    setAssignment: vi.fn(),
    reset: vi.fn(),
  };
}

function unknownQuantityReceipt(): Receipt {
  const receipt = confirmedReceipt();
  const item = receipt.items[0]!;
  item.quantityExact = null;
  item.evidence!.quantity = makeEvidence("unknown", [], ["The quantity was not recovered."]);
  item.flagged = true;
  return receipt;
}

afterEach(cleanup);
beforeEach(() => setBill(confirmedReceipt()));

describe("review and split field safety", () => {
  it("blocks Review continuation for an unknown quantity even when totals balance, and shows an empty quantity", () => {
    const receipt = unknownQuantityReceipt();
    setBill(receipt);
    expect(computeTotals(receipt)).toMatchObject({ ok: true, value: { mismatchCents: 0 } });
    render(<ReviewStep go={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Continue to split" })).toBeDisabled();
    expect(screen.getByLabelText("Qty")).toHaveValue("");
    expect(screen.getByLabelText("Qty")).toHaveAttribute("placeholder", "Unknown");
    expect(screen.getByText(/Item 1: Confirm the quantity/)).toBeInTheDocument();
    expect(screen.getByText("Matches the receipt total exactly.")).toBeInTheDocument();
  });

  it("keeps the same quantity reason visible and blocks Split summary despite a complete allocation", () => {
    setBill(unknownQuantityReceipt());
    const bill = mutableBill.current;
    expect(calculateBill(bill.receipt, bill.participants, bill.assignments).ok).toBe(true);
    render(<SplitStep go={vi.fn()} />);
    expect(screen.getByRole("button", { name: "See summary" })).toBeDisabled();
    expect(screen.getByText(/Item 1: Confirm the quantity/)).toBeInTheDocument();
    expect(screen.getByText(/Qty unknown \/ needs check/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "By qty" })).not.toBeInTheDocument();
  });

  it("keeps the quantity warning after the description edit callback updates and rerenders the receipt", () => {
    setBill(unknownQuantityReceipt());
    const view = render(<ReviewStep go={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Item 1/), {
      target: { value: "Updated synthetic product" },
    });
    expect(mutableBill.current.updateItem).toHaveBeenCalledWith("synthetic-product", {
      description: "Updated synthetic product",
    });
    view.rerender(<ReviewStep go={vi.fn()} />);
    expect(screen.getByLabelText(/Item 1/)).toHaveValue("Updated synthetic product");
    expect(screen.getByText(/Item 1: Confirm the quantity/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to split" })).toBeDisabled();
    expect(mutableBill.current.receipt.items[0]!.evidence?.quantity?.origin).toBe("unknown");
  });

  it("enables both flows for an explicitly confirmed, balanced and allocated receipt", () => {
    const reviewGo = vi.fn();
    const review = render(<ReviewStep go={reviewGo} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to split" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Continue to split" }));
    expect(reviewGo).toHaveBeenCalledWith("split");
    review.unmount();
    const splitGo = vi.fn();
    render(<SplitStep go={splitGo} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "See summary" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "See summary" }));
    expect(splitGo).toHaveBeenCalledWith("summary");
  });
});
