import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { sanitizeText, useBill } from "@/hooks/use-bill";
import { computeTotals } from "@/lib/bill";
import { formatMoney, formatRate, MAX_QUANTITY, parseRate } from "@/lib/money";
import type { ReceiptItem } from "@/lib/types";
import { Button, Card, Label, MoneyInput, Notice, Segmented, Toggle } from "./ui";
import { Shell } from "./Shell";

function QtyInput({ id, value, onChange }: { id: string; value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  const [err, setErr] = useState(false);
  return (
    <div>
      <Label htmlFor={id}>Qty</Label>
      <input id={id} inputMode="numeric" className="field-input money" value={text} aria-invalid={err}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d]/g, "").slice(0, 4);
          setText(t);
          const n = Number(t);
          const ok = t !== "" && Number.isSafeInteger(n) && n >= 1 && n <= MAX_QUANTITY;
          setErr(!ok);
          if (ok) onChange(n);
        }} />
      {err && <p className="mt-1 text-xs text-destructive">Whole number ≥ 1</p>}
    </div>
  );
}

function RateInput({ label, bp, onChange }: { label: string; bp: number; onChange: (bp: number) => void }) {
  const [text, setText] = useState(formatRate(bp));
  const [err, setErr] = useState(false);
  const id = `rate-${label}`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <input id={id} inputMode="decimal" className="field-input money pr-8" value={text} aria-invalid={err}
          onChange={(e) => { setText(e.target.value.slice(0, 6)); const v = parseRate(e.target.value); setErr(v === null); if (v !== null) onChange(v); }} />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
      </div>
      {err && <p className="mt-1 text-xs text-destructive">Enter 0–100, up to 2 decimals</p>}
    </div>
  );
}

function ItemRow({ item, index }: { item: ReceiptItem; index: number }) {
  const { updateItem, removeItem } = useBill();
  return (
    <li className={`rounded-lg border p-3 ${item.flagged ? "border-accent bg-warning/40" : "border-border"}`}>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Label htmlFor={`desc-${item.id}`}>Item {index + 1}{item.flagged && <span className="ml-1 rounded bg-warning px-1 text-xs text-warning-foreground">check</span>}</Label>
          <input id={`desc-${item.id}`} className="field-input" value={item.description} maxLength={80} placeholder="e.g. Chicken rice"
            onChange={(e) => updateItem(item.id, { description: sanitizeText(e.target.value, 80) })} />
        </div>
        <Button variant="danger" size="icon" aria-label={`Delete item ${index + 1}`} onClick={() => removeItem(item.id)}><Trash2 className="h-5 w-5" /></Button>
      </div>
      <div className="mt-2 grid grid-cols-[5rem_1fr] gap-2">
        <QtyInput id={`qty-${item.id}`} value={item.quantity} onChange={(n) => updateItem(item.id, { quantity: n })} />
        <MoneyInput id={`price-${item.id}`} label="Line total" hint={item.quantity > 1 ? `(for all ${item.quantity})` : "(full quantity)"} value={item.lineTotalCents} onChange={(c) => updateItem(item.id, { lineTotalCents: c })} />
      </div>
    </li>
  );
}

export function ReviewStep({ go }: { go: (s: "scan" | "split") => void }) {
  const { receipt: r, setReceipt, addItem } = useBill();
  const [showRaw, setShowRaw] = useState(false);
  const totals = computeTotals(r);
  const set = (patch: Partial<typeof r>) => setReceipt((x) => ({ ...x, ...patch }));
  const flagged = (f: string) => r.uncertainFields?.includes(f);
  const mismatch = totals.ok ? totals.value.mismatchCents : null;
  const canContinue = totals.ok && mismatch !== null && mismatch === 0 ? true : totals.ok && mismatch === null;

  return (
    <Shell step="review" footer={
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <Button variant="outline" onClick={() => go("scan")}>Back</Button>
        <Button disabled={!canContinue} onClick={() => go("split")}>Continue to split</Button>
      </div>
    }>
      <h1 className="text-2xl font-bold">Review receipt</h1>
      {r.ocrWarnings && r.ocrWarnings.length > 0 && (
        <Notice tone="warning" title="Check the scanned details">
          <ul className="list-disc pl-4">{r.ocrWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Notice>
      )}

      <Card>
        <Label htmlFor="merchant">Merchant{flagged("merchant") && <span className="ml-1 rounded bg-warning px-1 text-xs text-warning-foreground">check</span>}</Label>
        <input id="merchant" className="field-input" value={r.merchant} maxLength={60} placeholder="Restaurant name" onChange={(e) => set({ merchant: sanitizeText(e.target.value, 60) })} />
      </Card>

      <Card className="space-y-3">
        <div>
          <h2 className="font-semibold">Items</h2>
          <p className="text-xs text-muted-foreground">Enter the <strong>line total</strong> — the price for the whole quantity, as printed on the right of the receipt. Not the unit price.</p>
        </div>
        <ul className="space-y-2">{r.items.map((it, i) => <ItemRow key={it.id} item={it} index={i} />)}</ul>
        <Button variant="secondary" block onClick={addItem}><Plus className="h-5 w-5" aria-hidden /> Add item</Button>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Discount & charges <span className="text-sm font-normal text-muted-foreground">(SGD)</span></h2>
        <MoneyInput label="Bill discount" hint="(optional)" value={r.discountCents} onChange={(c) => set({ discountCents: c ?? 0 })} />
        <Segmented label="How charges are entered" value={r.chargeMode} onChange={(v) => set({ chargeMode: v })}
          options={[{ value: "percentage", label: "Calculate by %" }, { value: "receipt", label: "Amounts on receipt" }]} />
        <p className="text-xs text-muted-foreground">
          {r.chargeMode === "percentage"
            ? "Service charge is calculated on the subtotal after discount. GST is calculated on that plus service charge."
            : "Use the exact charge amounts printed on the receipt. No percentages are added on top."}
        </p>
        {flagged("charges") && <Notice tone="warning">No charges were detected — check whether this receipt has service charge or GST.</Notice>}

        <div className="rounded-lg border border-border p-3">
          <Toggle label="Service charge" checked={r.serviceEnabled} onChange={(v) => set({ serviceEnabled: v })} />
          {r.serviceEnabled && (r.chargeMode === "percentage"
            ? <RateInput key="svc" label="Service rate" bp={r.serviceRateBp} onChange={(bp) => set({ serviceRateBp: bp })} />
            : <MoneyInput label="Service charge amount" value={r.serviceAmountCents} onChange={(c) => set({ serviceAmountCents: c })} />)}
        </div>

        <div className="rounded-lg border border-border p-3">
          <Toggle label="GST" checked={r.gstEnabled} onChange={(v) => set({ gstEnabled: v })} />
          {r.gstEnabled && (
            <div className="space-y-2">
              <Toggle label="Prices already include GST" description="GST is shown for information only and not added again." checked={r.gstInclusive} onChange={(v) => set({ gstInclusive: v })} />
              {r.chargeMode === "percentage"
                ? <RateInput key="gst" label="GST rate" bp={r.gstRateBp} onChange={(bp) => set({ gstRateBp: bp })} />
                : <MoneyInput label={r.gstInclusive ? "GST included (from receipt)" : "GST amount"} value={r.gstAmountCents} onChange={(c) => set({ gstAmountCents: c })} />}
            </div>
          )}
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Totals</h2>
        {totals.ok ? (
          <dl className="space-y-1 text-sm">
            <Row k="Item subtotal" v={totals.value.itemSubtotalCents} />
            {r.printedSubtotalCents !== null && r.printedSubtotalCents !== totals.value.itemSubtotalCents && (
              <p className="text-xs text-warning-foreground">Printed subtotal was {formatMoney(r.printedSubtotalCents)}.</p>
            )}
            {r.printedNetSubtotalCents != null && (
              <p className="text-xs text-muted-foreground">Printed pre-tax subtotal: {formatMoney(r.printedNetSubtotalCents)}.</p>
            )}
            {totals.value.discountCents > 0 && <Row k="Discount" v={-totals.value.discountCents} />}
            {r.serviceEnabled && <Row k={`Service charge${r.chargeMode === "percentage" ? ` (${formatRate(r.serviceRateBp)}%)` : ""}`} v={totals.value.serviceCents} />}
            {r.gstEnabled && !r.gstInclusive && <Row k={`GST${r.chargeMode === "percentage" ? ` (${formatRate(r.gstRateBp)}%)` : ""}`} v={totals.value.gstAddedCents} />}
            <div className="flex justify-between border-t border-border pt-2 text-base font-bold"><dt>Calculated total</dt><dd className="money">{formatMoney(totals.value.totalCents)}</dd></div>
            {r.gstEnabled && r.gstInclusive && <Row k="incl. GST (not added)" v={totals.value.gstIncludedCents} muted />}
          </dl>
        ) : (
          <Notice tone="error"><ul className="list-disc pl-4">{totals.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Notice>
        )}
        <MoneyInput label="Receipt total" hint="(grand total printed on receipt)" flagged={flagged("total")} value={r.receiptTotalCents} onChange={(c) => set({ receiptTotalCents: c })} />
        {totals.ok && mismatch !== null && (mismatch === 0
          ? <Notice tone="success">Matches the receipt total exactly.</Notice>
          : <Notice tone="error" title={`Off by ${Math.abs(mismatch)} cent${Math.abs(mismatch) === 1 ? "" : "s"}`}>
              The receipt total is {mismatch > 0 ? "higher" : "lower"} than the calculated total. Fix the items, discount or charges (or the receipt total) before continuing.
            </Notice>)}
        {totals.ok && mismatch === null && <Notice tone="info">Enter the receipt total to double-check the maths.</Notice>}
      </Card>

      {r.rawOcrText && (
        <Card>
          <Button variant="ghost" size="sm" aria-expanded={showRaw} onClick={() => setShowRaw((s) => !s)}>{showRaw ? "Hide" : "Show"} scanned text</Button>
          {showRaw && <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{r.rawOcrText}</pre>}
        </Card>
      )}
    </Shell>
  );
}

function Row({ k, v, muted }: { k: string; v: number; muted?: boolean }) {
  return <div className={`flex justify-between ${muted ? "text-muted-foreground" : ""}`}><dt>{k}</dt><dd className="money">{formatMoney(v)}</dd></div>;
}

