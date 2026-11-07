import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emptyReceipt } from "@/lib/defaults";
import { confirmReceiptField, makeEvidence } from "@/lib/receipt-quality";
import { applySavedPreferences, loadSavedPreferences } from "@/lib/preferences";
import { ReviewConfirmations } from "./ReviewConfirmations";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe("scoped confirmation controls", () => {
  it("offers only the confirmed currency and never silently saves untouched rate defaults", () => {
    const value = confirmReceiptField(emptyReceipt(), "currency");
    const onChange = vi.fn();
    render(<ReviewConfirmations receipt={value} onChangeReceipt={onChange} />);
    expect(screen.getByText("Save these as your defaults?")).toBeInTheDocument();
    expect(screen.getByText("SGD")).toBeInTheDocument();
    expect(screen.queryByText("9%")).not.toBeInTheDocument();
    expect(screen.queryByText("10%")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save selected defaults" }));
    expect(loadSavedPreferences()?.currency?.value).toBe("SGD");
    expect(loadSavedPreferences()?.gstRateBp).toBeUndefined();
    expect(loadSavedPreferences()?.serviceRateBp).toBeUndefined();
    expect(onChange).toHaveBeenCalledWith({ ...value, preferencePromptHandled: true });
  });
  it("declining leaves every receipt field untouched and the optional offer stays closed on remount", () => {
    const value = confirmReceiptField(emptyReceipt(), "currency");
    const onChange = vi.fn();
    const view = render(<ReviewConfirmations receipt={value} onChangeReceipt={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    const next = onChange.mock.calls[0]![0];
    expect(next).toEqual({ ...value, preferencePromptHandled: true });
    expect(loadSavedPreferences()).toBeNull();
    expect(screen.queryByText("Save these as your defaults?")).not.toBeInTheDocument();
    view.unmount();
    render(<ReviewConfirmations receipt={next} onChangeReceipt={onChange} />);
    expect(screen.queryByText("Save these as your defaults?")).not.toBeInTheDocument();
  });
  it("offers one prompt after the first eligible confirmation, without requiring preference setup", () => {
    const value = emptyReceipt(); const onChange = vi.fn();
    const view = render(<ReviewConfirmations receipt={value} onChangeReceipt={onChange} />);
    expect(screen.queryByText("Save these as your defaults?")).not.toBeInTheDocument();
    view.rerender(<ReviewConfirmations receipt={confirmReceiptField(value, "currency")} onChangeReceipt={onChange} />);
    expect(screen.getAllByText("Save these as your defaults?")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    view.rerender(<ReviewConfirmations receipt={confirmReceiptField(confirmReceiptField(value, "currency"), "gstRateBp")} onChangeReceipt={onChange} />);
    expect(screen.queryByText("Save these as your defaults?")).not.toBeInTheDocument();
  });
  it("lists four printed fields, excludes inferred GST treatment and records one bulk tap as four field actions", () => {
    const value = { ...emptyReceipt(), serviceEnabled: true, gstEnabled: true };
    value.evidence = {
      service: makeEvidence("observed", [{ kind: "text", text: "Service charge 10%" }]),
      serviceRateBp: makeEvidence("observed", [{ kind: "text", text: "Service charge 10%" }]),
      gst: makeEvidence("observed", [{ kind: "text", text: "GST 9%" }]),
      gstRateBp: makeEvidence("observed", [{ kind: "text", text: "GST 9%" }]),
      gstInclusive: makeEvidence("inferred", [{ kind: "calculation", text: "Arithmetic GST treatment" }]),
    };
    const onChange = vi.fn(); const onAction = vi.fn();
    render(<ReviewConfirmations receipt={value} onChangeReceipt={onChange} onAction={onAction} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    expect(screen.queryByText("GST treatment:")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm 4 selected charge fields" }));
    expect(onAction).toHaveBeenCalledWith({ type: "printed-charge-confirmation", fields: ["service", "gst", "serviceRateBp", "gstRateBp"], fieldActions: 4, interactions: 1 });
    const next = onChange.mock.calls[0]![0];
    expect(next.evidence.gstInclusive).toEqual(value.evidence.gstInclusive);
    expect(next.evidence.service.sources[0]).toEqual(value.evidence.service!.sources[0]);
    expect(next.evidence.service.sources.at(-1).kind).toBe("user");
  });
  it("allows selective bulk confirmation without changing an unselected charge", () => {
    const value = { ...emptyReceipt(), chargeMode: "receipt" as const, serviceEnabled: false, gstEnabled: false,
      evidence: { service: makeEvidence("observed", [{ kind: "text", text: "No service charge" }]),
        gst: makeEvidence("observed", [{ kind: "text", text: "No GST" }]) } };
    const onChange = vi.fn();
    render(<ReviewConfirmations receipt={value} onChangeReceipt={onChange} />);
    fireEvent.click(screen.getByLabelText("GST: No charge"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm 1 selected charge field" }));
    const next = onChange.mock.calls[0]![0];
    expect(next.evidence.service.origin).toBe("user-confirmed");
    expect(next.evidence.gst).toEqual(value.evidence.gst);
  });
  it("lists newly eligible fields after a state change without silently selecting or confirming them", () => {
    const initial = emptyReceipt(); const onChange = vi.fn();
    const view = render(<ReviewConfirmations receipt={initial} onChangeReceipt={onChange} />);
    const next = { ...initial, chargeMode: "receipt" as const, serviceEnabled: false,
      evidence: { service: makeEvidence("observed", [{ kind: "text", text: "No service charge" }]) } };
    view.rerender(<ReviewConfirmations receipt={next} onChangeReceipt={onChange} />);
    const checkbox = screen.getByLabelText("Service charge: No charge");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Confirm 0 selected charge fields" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Confirm 1 selected charge field" }));
    expect(onChange.mock.calls[0]![0].evidence.service.origin).toBe("user-confirmed");
  });
  it("shows receipt versus saved rates and confirms the receipt value individually without changing defaults", () => {
    const initial = { ...emptyReceipt(), chargeMode: "receipt" as const, gstRateBp: 900 };
    initial.evidence!.gstRateBp = makeEvidence("observed", [{ kind: "text", text: "GST 9%", observedValue: 900 }]);
    const conflicted = applySavedPreferences(initial, { schemaVersion: 1, gstRateBp: { value: 800, confirmedAt: "2026-10-24T00:00:00.000Z" } });
    const onChange = vi.fn(); const onAction = vi.fn();
    const view = render(<ReviewConfirmations receipt={conflicted} onChangeReceipt={onChange} onAction={onAction} />);
    expect(screen.getByText("Receipt values differ from saved defaults")).toBeInTheDocument();
    expect(screen.getByText("9%")).toBeInTheDocument(); expect(screen.getByText("8%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm receipt gst rate 9%" }));
    const next = onChange.mock.calls[0]![0];
    expect(next.gstRateBp).toBe(900);
    expect(next.evidence.gstRateBp.origin).toBe("user-confirmed");
    expect(next.evidence.gstRateBp.sources[0]).toEqual(initial.evidence!.gstRateBp.sources[0]);
    expect(next.evidence.gstRateBp.sources.some((source: { kind: string }) => source.kind === "preference")).toBe(true);
    expect(loadSavedPreferences()).toBeNull();
    expect(onAction).toHaveBeenCalledWith({ type: "preference-conflict-confirmation", fields: ["gstRateBp"], fieldActions: 1, interactions: 1 });
    view.rerender(<ReviewConfirmations receipt={next} onChangeReceipt={onChange} />);
    expect(screen.queryByText("Receipt values differ from saved defaults")).not.toBeInTheDocument();
    expect(screen.getByText("Save these as your defaults?")).toBeInTheDocument();
  });
});
