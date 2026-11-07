import type { ItemAssignment, Participant, Receipt } from "./types";
import { makeEvidence } from "./receipt-quality";

/** Editable product defaults (SG): 10% service charge, 9% GST. Not every receipt follows these. */
export const DEFAULT_SERVICE_BP = 1000;
export const DEFAULT_GST_BP = 900;

export function emptyReceipt(): Receipt {
  return {
    merchant: "",
    currency: "SGD",
    items: [],
    printedSubtotalCents: null,
    discountCents: 0,
    chargeMode: "percentage",
    serviceEnabled: true,
    serviceRateBp: DEFAULT_SERVICE_BP,
    serviceAmountCents: null,
    gstEnabled: true,
    gstRateBp: DEFAULT_GST_BP,
    gstAmountCents: null,
    gstInclusive: false,
    receiptTotalCents: null,
    evidence: {
      currency: makeEvidence("defaulted", [], ["Currency is an application preference; confirm it for this receipt."]),
      discountCents: makeEvidence("defaulted", [], ["Confirm the discount, including a verified absence of discount."]),
      service: makeEvidence("defaulted", [], ["Service settings are application preferences, not observed charges."]),
      gst: makeEvidence("defaulted", [], ["GST settings are application preferences, not observed tax."]),
      gstInclusive: makeEvidence("defaulted", [], ["Confirm whether GST is included or added."]),
      serviceRateBp: makeEvidence("defaulted", [], ["The service rate is an application preference."]),
      gstRateBp: makeEvidence("defaulted", [], ["The GST rate is an application preference."]),
      total: makeEvidence("unknown", [], ["Check the printed total, or confirm that it is not printed."]),
    },
  };
}

export function sampleSession(): { receipt: Receipt; participants: Participant[]; assignments: Record<string, ItemAssignment> } {
  const receipt: Receipt = {
    ...emptyReceipt(),
    merchant: "Sample Hawker Centre",
    items: [
      { id: "i_sample_1", description: "Chicken rice", quantity: 1, lineTotalCents: 600 },
      { id: "i_sample_2", description: "Pizza", quantity: 1, lineTotalCents: 2400 },
      { id: "i_sample_3", description: "Fries", quantity: 1, lineTotalCents: 800 },
    ],
    printedSubtotalCents: 3800,
    receiptTotalCents: 4556,
  };
  const participants: Participant[] = [
    { id: "p_sample_1", name: "Alex" },
    { id: "p_sample_2", name: "Ben" },
    { id: "p_sample_3", name: "Chloe" },
    { id: "p_sample_4", name: "Daniel" },
  ];
  // The built-in demo has declared synthetic values, separate from scanned evidence.
  const demo = () => makeEvidence("user-confirmed", [{ kind: "user", text: "Built-in synthetic sample selected" }]);
  receipt.evidence = { currency: demo(), discountCents: demo(), service: demo(), gst: demo(), serviceRateBp: demo(), gstRateBp: demo(), gstInclusive: demo(), total: demo() };
  receipt.items = receipt.items.map(item => ({ ...item, quantityExact: { numerator: item.quantity, denominator: 1 }, evidence: { description: demo(), quantity: demo(), lineTotalCents: demo() } }));
  const a = (itemId: string, mode: ItemAssignment["mode"], participantIds: string[]): ItemAssignment => ({ itemId, mode, participantIds, quantities: {}, amounts: {} });
  return {
    receipt,
    participants,
    assignments: {
      i_sample_1: a("i_sample_1", "single", ["p_sample_1"]),
      i_sample_2: a("i_sample_2", "even", ["p_sample_2", "p_sample_3"]),
      i_sample_3: a("i_sample_3", "even", ["p_sample_1", "p_sample_2", "p_sample_3", "p_sample_4"]),
    },
  };
}
