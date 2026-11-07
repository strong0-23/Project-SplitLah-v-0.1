import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emptyReceipt } from "@/lib/defaults";
import { makeEvidence } from "@/lib/receipt-quality";
import { parseReceiptText } from "@/lib/parser";
import type { Receipt, ReceiptItem } from "@/lib/types";
import { QuantityReview } from "./QuantityReview";

afterEach(cleanup);
const product = (id: string, description = id, line = 1): ReceiptItem => ({
  id, description, rowKind: "product", quantity: 1, quantityExact: null, lineTotalCents: 100,
  evidence: {
    description: makeEvidence("observed", [{ kind: "text", text: description, lineIndices: [line] }]),
    quantity: makeEvidence("unknown", [{ kind: "text", text: "Synthetic source: quantity unresolved", lineIndices: [line] }]),
    lineTotalCents: makeEvidence("observed", [{ kind: "text", text: "1.00", lineIndices: [line] }]),
    role: makeEvidence("observed"),
  }, flagged: true,
});
const receipt = (items: ReceiptItem[]): Receipt => ({ ...emptyReceipt(), items });

describe("quantity bulk review", () => {
  it("starts unknown rows unchecked and records only selected entries as user input with original sources", () => {
    const original = receipt([product("tea"), product("cake"), product("juice")]);
    const onChange = vi.fn();
    render(<QuantityReview receipt={original} onChangeReceipt={onChange} />);
    const button = screen.getByRole("button", { name: "Apply quantity 1 to 0 selected rows" });
    expect(button).toBeDisabled();
    expect(screen.getAllByRole("checkbox").every(checkbox => !(checkbox as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(screen.getByLabelText("tea: enter quantity 1 after checking"));
    fireEvent.click(screen.getByLabelText("cake: enter quantity 1 after checking"));
    expect(screen.getByText(/Applying to 2 rows is 2 separate field entries/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply quantity 1 to 2 selected rows" }));
    const next: Receipt = onChange.mock.calls[0]![0];
    expect(next.items.filter(item => item.evidence?.quantity?.origin === "user-confirmed")).toHaveLength(2);
    for (const item of next.items.slice(0, 2)) {
      expect(item.quantityExact).toEqual({ numerator: 1, denominator: 1 });
      expect(item.evidence?.quantity?.previousOrigin).toBe("unknown");
      expect(item.evidence?.quantity?.sources[0]).toEqual(original.items[0]?.evidence?.quantity?.sources[0]);
      expect(item.evidence?.quantity?.sources.at(-1)?.kind).toBe("user");
    }
    expect(next.items[2]).toBe(original.items[2]);
  });
  it("select-all is only a selection step and cannot silently enter or confirm quantities", () => {
    const original = receipt([product("tea"), product("cake")]); const onChange = vi.fn();
    render(<QuantityReview receipt={original} onChangeReceipt={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Select all shown count rows" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Apply quantity 1 to 2 selected rows" })).toBeEnabled();
    expect(original.items.every(item => item.quantityExact === null)).toBe(true);
  });
  it("excludes measured, fractional and observed rows from count default entry", () => {
    const weighted = { ...product("weighted", "Apples"), unitOfMeasure: "kg" };
    const measuredDescription = product("measured", "Loose rice per kg");
    const fractional = { ...product("fractional"), quantity: 0.5, quantityExact: { numerator: 1, denominator: 2 } };
    const observed = { ...product("observed"), quantity: 2, quantityExact: { numerator: 2, denominator: 1 },
      evidence: { quantity: makeEvidence("observed") } };
    render(<QuantityReview receipt={receipt([product("tea"), weighted, measuredDescription, fractional, observed])} onChangeReceipt={vi.fn()} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByLabelText("tea: enter quantity 1 after checking")).toBeInTheDocument();
    expect(screen.queryByText("Apples: enter quantity 1 after checking")).not.toBeInTheDocument();
    expect(screen.queryByText("fractional: enter quantity 1 after checking")).not.toBeInTheDocument();
  });
  it("lists supported implicit-layout defaults separately and retains default provenance after confirmation", () => {
    const text = "Synthetic shop\nDescription  Amount\nCoffee       1.00\nCake         1.00\nTOTAL 2.00";
    const proposed = parseReceiptText(text).receipt;
    const onChange = vi.fn();
    render(<QuantityReview receipt={proposed} onChangeReceipt={onChange} />);
    expect(screen.getByText("Coffee: proposed quantity 1")).toBeInTheDocument();
    expect(screen.getByText(/flagged defaults, not printed quantities/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Cake: proposed quantity 1"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm 1 selected quantity defaults" }));
    const next: Receipt = onChange.mock.calls[0]![0];
    expect(next.items[0]?.evidence?.quantity?.origin).toBe("user-confirmed");
    expect(next.items[0]?.evidence?.quantity?.previousOrigin).toBe("defaulted");
    expect(next.items[0]?.quantityDefaultBasis).toBe("implicit-layout");
    expect(next.items[0]?.evidence?.quantity?.sources.slice(0, -1)).toEqual(proposed.items[0]?.evidence?.quantity?.sources);
    expect(next.items[1]).toBe(proposed.items[1]);
  });
  it("does not offer implicit default confirmation from a marker without positive layout evidence", () => {
    const unsupported = { ...product("tea"), quantityExact: { numerator: 1, denominator: 1 }, quantityDefaultBasis: "implicit-layout" as const,
      evidence: { quantity: makeEvidence("defaulted") } };
    render(<QuantityReview receipt={receipt([unsupported])} onChangeReceipt={vi.fn()} />);
    expect(screen.queryByText("Check proposed quantities")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm .* selected quantity defaults/ })).not.toBeInTheDocument();
  });
});
