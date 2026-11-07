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
    await screen.findByDisplayValue("Pad Thai");
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
    await screen.findByDisplayValue("Truffle Fries");
    fireEvent.click(screen.getByRole("radio", { name: "Calculate by %" }));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });
});
