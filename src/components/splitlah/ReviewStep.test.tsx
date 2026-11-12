/**
 * Review screen: the D6 fee warning (brief task 1a). Synthetic receipts only.
 */
import { useEffect, useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { BillProvider, useBill } from "@/hooks/use-bill";
import { parseReceiptText } from "@/lib/scan";
import { ReviewStep } from "./ReviewStep";

const WARNING = "Your receipt's delivery/platform fees will drop out if you calculate by %.";

const DELIVERY = `SAMPLE THAI KITCHEN
Pad Thai             2    24.00
Green Curry          1    15.00
Subtotal                  39.00
Service Charge 10%         3.90
Delivery Charge            5.00
Packaging Fee              0.60
GST 9%                     4.37
Total                     52.87`;

const RESTAURANT = `THE EXAMPLE BISTRO
Truffle Fries   1    12.00
Subtotal             12.00
Service Charge 10%    1.20
GST 9%                1.19
TOTAL                14.39`;

function Scanned({ text }: { text: string }) {
  const { startFromReceipt } = useBill();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // load the scanned receipt once, as ScanStep does
    started.current = true;
    startFromReceipt(parseReceiptText(text).receipt);
  }, [startFromReceipt, text]);
  return <ReviewStep go={() => undefined} />;
}

const renderReview = (text: string) =>
  render(
    <BillProvider>
      <Scanned text={text} />
    </BillProvider>,
  );

describe("ReviewStep: delivery/platform fee warning", () => {
  beforeEach(() => localStorage.clear());

  it("appears when a receipt with folded-in fees is switched to Calculate by %", async () => {
    renderReview(DELIVERY);
    await screen.findByDisplayValue("Pad Thai 2"); // Batch 1b: unheaded "2" stays in the name
    expect(screen.getByRole("radio", { name: "Amounts on receipt" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Calculate by %" }));
    expect(screen.getByText(WARNING)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Amounts on receipt" }));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it("does not appear for a receipt whose service amount has no fees", async () => {
    renderReview(RESTAURANT);
    await screen.findByDisplayValue("Truffle Fries 1"); // Batch 1b: unheaded "1" stays in the name
    fireEvent.click(screen.getByRole("radio", { name: "Calculate by %" }));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });
});

// ---- Batch 3: fast corrections (synthetic receipts only) ----------------------------------------

/** A header row ("Queue 58 3.00") the total doesn't need: the anchor hides it. */
const HEADER_ROW = `SAMPLE NOODLE HOUSE
Queue 58   3.00
Date 01/11/2026 12:30
Wonton Noodles   6.40
Barley Drink     1.70
Total            8.10
VISA             8.10`;

/** Items short of the printed total by 2.00. */
const SHORT = `SAMPLE CAFE
Item        Amount
Flat White    5.00
Banana Bread  4.00
Total        11.00`;

/** One item whose price had a letter fixed (D8): flagged, with a reason. */
const REPAIRED = `SAMPLE DINER
Item           Amount
Fish Burger    1O.50
Total          10.50`;

describe("ReviewStep: hidden lines", () => {
  beforeEach(() => localStorage.clear());

  it("collapses lines the total doesn't need under a small expander, and can add one back", async () => {
    renderReview(HEADER_ROW);
    await screen.findByDisplayValue("Wonton Noodles");
    expect(screen.queryByDisplayValue("Queue 58")).not.toBeInTheDocument();
    // The match is not shown as plain success while lines are hidden.
    expect(screen.queryByText("Matches the receipt total exactly.")).not.toBeInTheDocument();
    expect(screen.getByText(/Matches the receipt total, with 1 line hidden/)).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "1 line hidden — show" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Queue 58")).toBeInTheDocument();
    expect(screen.getByText(/Not needed to reach the printed total/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add back Queue 58" }));
    expect(screen.getByDisplayValue("Queue 58")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /line hidden/ })).not.toBeInTheDocument();
    // Now the items exceed the total: the banner shows the difference.
    expect(
      screen.getByText(/Doesn't match the receipt total: over by SGD 3\.00/),
    ).toBeInTheDocument();
  });
});

describe("ReviewStep: a line added back and deleted again", () => {
  beforeEach(() => localStorage.clear());

  it("is offered again under the hidden lines", async () => {
    renderReview(HEADER_ROW);
    await screen.findByDisplayValue("Wonton Noodles");
    fireEvent.click(screen.getByRole("button", { name: "1 line hidden — show" }));
    fireEvent.click(screen.getByRole("button", { name: "Add back Queue 58" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete item 3" }));
    expect(screen.queryByDisplayValue("Queue 58")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 line hidden/ })).toBeInTheDocument();
  });
});

describe("ReviewStep: one-tap remove with undo", () => {
  beforeEach(() => localStorage.clear());

  it("removes an item at once and brings it back in place with Undo", async () => {
    renderReview(SHORT);
    await screen.findByDisplayValue("Flat White");
    fireEvent.click(screen.getByRole("button", { name: "Delete item 1" }));
    expect(screen.queryByDisplayValue("Flat White")).not.toBeInTheDocument();
    expect(screen.getByText("Removed “Flat White”.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    const descs = screen.getAllByLabelText(/^Item \d/).map((el) => (el as HTMLInputElement).value);
    expect(descs).toEqual(["Flat White", "Banana Bread"]);
    expect(screen.queryByText(/Removed/)).not.toBeInTheDocument();
  });
});

describe("ReviewStep: highlights and the total banner", () => {
  beforeEach(() => localStorage.clear());

  it("shows a short reason under a highlighted row", async () => {
    renderReview(REPAIRED);
    const input = await screen.findByDisplayValue("Fish Burger");
    expect(screen.getByText("Letters in the price were fixed")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-describedby");
  });

  it("shows a clear banner with the difference when items and charges miss the printed total", async () => {
    renderReview(SHORT);
    await screen.findByDisplayValue("Flat White");
    expect(
      screen.getByText(/Doesn't match the receipt total: short by SGD 2\.00/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Items and charges come to SGD 9\.00; the receipt total is SGD 11\.00/),
    ).toBeInTheDocument();
  });

  it("shows no banner and plain success when everything matches with nothing hidden", async () => {
    renderReview(REPAIRED);
    await screen.findByDisplayValue("Fish Burger");
    expect(screen.queryByText(/Doesn't match the receipt total/)).not.toBeInTheDocument();
    expect(screen.getByText("Matches the receipt total exactly.")).toBeInTheDocument();
  });
});
