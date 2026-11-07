import { useState } from "react";
import type { Receipt } from "@/lib/types";
import { applyUserQuantityOne, confirmQuantityDefaults, eligibleQuantityDefaults, isCompatibleCountRow } from "@/lib/quantity-defaults";
import { Button, Card } from "./ui";

export function QuantityReview({ receipt, onChangeReceipt }: { receipt: Receipt; onChangeReceipt: (receipt: Receipt) => void }) {
  const defaults = eligibleQuantityDefaults(receipt);
  const unknown = receipt.items.filter(item => item.quantityExact === null && isCompatibleCountRow(item));
  const [selectedDefaults, setSelectedDefaults] = useState<string[] | null>(null);
  const [selectedUnknown, setSelectedUnknown] = useState<string[]>([]);
  const defaultsSelected = defaults.filter(item => (selectedDefaults ?? defaults.map(row => row.id)).includes(item.id));
  const unknownSelected = unknown.filter(item => selectedUnknown.includes(item.id));
  return <>
    {defaults.length > 0 && <Card className="space-y-3">
      <h2 className="font-semibold">Check proposed quantities</h2>
      <p className="text-sm">The aligned description/amount layout supports a proposed quantity of 1. These are flagged defaults, not printed quantities. Check each product against the receipt.</p>
      {defaults.map(item => <label key={item.id} className="flex gap-2"><input type="checkbox" checked={defaultsSelected.some(row => row.id === item.id)} onChange={event => setSelectedDefaults(event.target.checked ? [...defaultsSelected.map(row => row.id), item.id] : defaultsSelected.filter(row => row.id !== item.id).map(row => row.id))} />{item.description}: proposed quantity 1</label>)}
      <Button variant="outline" disabled={!defaultsSelected.length} onClick={() => onChangeReceipt(confirmQuantityDefaults(receipt, defaultsSelected.map(item => item.id)))}>Confirm {defaultsSelected.length} selected quantity defaults</Button>
      <p className="text-xs">One click confirms {defaultsSelected.length} quantity fields. Original default provenance is retained.</p>
    </Card>}
    {unknown.length > 0 && <Card className="space-y-3">
      <h2 className="font-semibold">Enter quantity 1 for checked count rows</h2>
      <p className="text-sm">These quantities remain unknown. Only select products you have checked are count-based and were bought once. This records your input; it does not claim the scanner read a 1.</p>
      {unknown.map(item => <label key={item.id} className="flex gap-2"><input type="checkbox" checked={selectedUnknown.includes(item.id)} onChange={event => setSelectedUnknown(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />{item.description}: enter quantity 1 after checking</label>)}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => setSelectedUnknown(unknown.map(item => item.id))}>Select all shown count rows</Button>
      <Button variant="outline" disabled={!unknownSelected.length} onClick={() => { onChangeReceipt(applyUserQuantityOne(receipt, unknownSelected.map(item => item.id))); setSelectedUnknown([]); }}>Apply quantity 1 to {unknownSelected.length} selected rows</Button></div>
      <p className="text-xs">Applying to {unknownSelected.length} rows is {unknownSelected.length} separate field entries, even when submitted together. Enter other quantities individually above.</p>
    </Card>}
  </>;
}
