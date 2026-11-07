import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { sanitizeText, useBill } from "@/hooks/use-bill";
import { computeTotals } from "@/lib/bill";
import { formatMoney, formatRate, parseRate } from "@/lib/money";
import type { ItemField, ReceiptField, ReceiptItem, RationalQuantity } from "@/lib/types";
import { itemFieldNeedsReview, makeEvidence, reconcileRowReviewEvidence, rowReviewState, updateReceiptWithEvidence } from "@/lib/receipt-quality";
import { assessReceipt } from "@/lib/receipt-status";
import { formatQuantity, parseQuantity, quantityNumber } from "@/lib/quantity";
import { EvidenceNote, ReceiptStatus } from "./ReceiptStatus";
import { Button, Card, Label, MoneyInput, Notice, Segmented, Toggle } from "./ui";
import { Shell } from "./Shell";
import { ReviewConfirmations } from "./ReviewConfirmations";
import { QuantityReview } from "./QuantityReview";

function QtyInput({ id, value, onChange }: { id: string; value: RationalQuantity | null; onChange: (n: RationalQuantity | null) => void }) {
  const [text, setText] = useState(value ? formatQuantity(value) : "");
  const [err, setErr] = useState(false);
  useEffect(() => { if (!err) setText(value ? formatQuantity(value) : ""); }, [value?.numerator, value?.denominator]);
  return (
    <div>
      <Label htmlFor={id}>Qty</Label>
      <input id={id} inputMode="decimal" placeholder="Unknown" className="field-input money" value={text} aria-invalid={err}
        onChange={(e) => {
          const t = e.target.value.slice(0, 20);
          setText(t);
          const n = parseQuantity(t);
          const ok = n !== null && n.numerator !== 0;
          setErr(!ok);
          onChange(ok ? n : null);
        }} />
      {err && <p className="mt-1 text-xs text-destructive">Enter an exact quantity such as 1, 0.375 or 3/2.</p>}
    </div>
  );
}

function RateInput({ label, bp, onChange, onInvalid }: { label: string; bp: number; onChange: (bp: number) => void; onInvalid: () => void }) {
  const [text, setText] = useState(formatRate(bp));
  const [err, setErr] = useState(false);
  const id = `rate-${label}`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <input id={id} inputMode="decimal" className="field-input money pr-8" value={text} aria-invalid={err}
          onChange={(e) => { setText(e.target.value.slice(0, 6)); const v = parseRate(e.target.value); setErr(v === null); if (v !== null) onChange(v); else onInvalid(); }} />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
      </div>
      {err && <p className="mt-1 text-xs text-destructive">Enter 0–100, up to 2 decimals</p>}
    </div>
  );
}

function ItemRow({ item, index }: { item: ReceiptItem; index: number }) {
  const { updateItem, removeItem, confirmItem } = useBill();
  const check = (field: ItemField) => <><EvidenceNote evidence={item.evidence?.[field]} />{itemFieldNeedsReview(item, field) && <Button size="sm" variant="outline" onClick={() => confirmItem(item.id, field)}>Confirm {field === "lineTotalCents" ? "line total" : field === "unitPriceCents" ? "unit price" : field === "pricingBasis" ? "pricing basis" : field}</Button>}</>;
  return (
    <li className={`rounded-lg border p-3 ${item.flagged ? "border-accent bg-warning/40" : "border-border"}`}>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Label htmlFor={`desc-${item.id}`}>Item {index + 1}{item.flagged && <span className="ml-1 rounded bg-warning px-1 text-xs text-warning-foreground">check</span>}</Label>
          <input id={`desc-${item.id}`} className="field-input" value={item.description} maxLength={80} placeholder="e.g. Chicken rice"
            onChange={(e) => updateItem(item.id, { description: sanitizeText(e.target.value, 80) })} />
          {check("description")}
        </div>
        <Button variant="danger" size="icon" aria-label={`Delete item ${index + 1}`} onClick={() => removeItem(item.id)}><Trash2 className="h-5 w-5" /></Button>
      </div>
      <div className="mt-2 grid grid-cols-[5rem_1fr] gap-2">
        <div><QtyInput id={`qty-${item.id}`} value={item.evidence?.quantity?.origin === "unknown" ? null : item.quantityExact ?? null} onChange={q => updateItem(item.id, q ? { quantity: quantityNumber(q), quantityExact: q } : { quantityExact: null })} />{check("quantity")}</div>
        <div><MoneyInput id={`price-${item.id}`} label="Line total" allowNegative={item.rowKind === "return" || item.rowKind === "adjustment"} hint="(full quantity)" flagged={itemFieldNeedsReview(item, "lineTotalCents")} value={item.lineTotalCents} onChange={(c) => updateItem(item.id, { lineTotalCents: c })} />{check("lineTotalCents")}</div>
      </div>
      {item.evidence?.quantity?.origin === "inferred" && <p className="text-sm text-warning-foreground">Quantity auto-filled, please check. Exact price division does not prove the quantity.</p>}
      {item.unitPriceCents != null && <div className="mt-2"><MoneyInput label="Unit price" allowNegative={item.rowKind === "return" || item.rowKind === "adjustment"} value={item.unitPriceCents} onChange={c => updateItem(item.id, { unitPriceCents: c })} hint={item.priceBasis ? `(per ${formatQuantity(item.priceBasis.quantity)} ${item.priceBasis.unit})` : "(pricing basis needs check)"} />{check("unitPriceCents")}
        <details className="mt-2 rounded border p-2 text-sm"><summary>Check quantity and price basis</summary>
          <p className="my-2 text-xs">Choose these only after checking the receipt. These choices do not waive an amount mismatch.</p>
          <Label htmlFor={`uom-${item.id}`}>Quantity unit</Label><select id={`uom-${item.id}`} className="field-input" value={item.unitOfMeasure ?? ""} onChange={e => updateItem(item.id, { unitOfMeasure: e.target.value })}><option value="">Unknown</option>{["count", "g", "kg", "ml", "l"].map(unit => <option key={unit}>{unit}</option>)}</select>
          <Label htmlFor={`basis-unit-${item.id}`}>Unit-price unit</Label><select id={`basis-unit-${item.id}`} className="field-input" value={item.priceBasis?.unit ?? ""} onChange={e => updateItem(item.id, { priceBasis: { quantity: item.priceBasis?.quantity ?? { numerator: 1, denominator: 1 }, unit: e.target.value } })}><option value="">Unknown</option>{["count", "g", "kg", "ml", "l"].map(unit => <option key={unit}>{unit}</option>)}</select>
          <QtyInput id={`basis-qty-${item.id}`} value={item.priceBasis?.quantity ?? null} onChange={q => q && q.numerator > 0 ? updateItem(item.id, { priceBasis: { quantity: q, unit: item.priceBasis?.unit ?? "" } }) : updateItem(item.id, { pricingContext: { discounts: item.pricingContext?.discounts ?? "unresolved", tax: item.pricingContext?.tax ?? "unresolved", adjustment: "unresolved" } })} />
          <p className="text-xs">The quantity above is how many units one unit price covers.</p>
          <Label htmlFor={`discount-basis-${item.id}`}>Discount pricing basis</Label><select id={`discount-basis-${item.id}`} className="field-input" value={item.pricingContext?.discounts ?? "unresolved"} onChange={e => updateItem(item.id, { pricingContext: { discounts: e.target.value as "none" | "included" | "unresolved", tax: item.pricingContext?.tax ?? "unresolved", adjustment: item.pricingContext?.adjustment ?? "unresolved" } })}><option value="unresolved">Unresolved</option><option value="none">No item discount</option><option value="included">Both prices already use the same discounted basis</option></select>
          <Label htmlFor={`tax-basis-${item.id}`}>Tax pricing basis</Label><select id={`tax-basis-${item.id}`} className="field-input" value={item.pricingContext?.tax ?? "unresolved"} onChange={e => updateItem(item.id, { pricingContext: { discounts: item.pricingContext?.discounts ?? "unresolved", tax: e.target.value as "compatible" | "unresolved", adjustment: item.pricingContext?.adjustment ?? "unresolved" } })}><option value="unresolved">Unresolved</option><option value="compatible">Both prices use the same tax basis</option></select>
          <Label htmlFor={`adjustment-basis-${item.id}`}>Other price adjustments</Label><select id={`adjustment-basis-${item.id}`} className="field-input" value={item.pricingContext?.adjustment ?? "unresolved"} onChange={e => updateItem(item.id, { pricingContext: { discounts: item.pricingContext?.discounts ?? "unresolved", tax: item.pricingContext?.tax ?? "unresolved", adjustment: e.target.value as "none" | "unresolved" } })}><option value="unresolved">Unresolved</option><option value="none">No other adjustment</option></select>
          {check("pricingBasis")}
        </details>
      </div>}
      <div className="mt-2"><Label htmlFor={`role-${item.id}`}>Row type</Label><select id={`role-${item.id}`} className="field-input" value={item.rowKind ?? "product"} onChange={e => updateItem(item.id, { rowKind: e.target.value as ReceiptItem["rowKind"], ...(e.target.value === "adjustment" ? { pricingContext: { discounts: "unresolved", tax: "unresolved", adjustment: "explicit" } as const } : {}) })}><option value="product">Purchase</option><option value="return">Return</option><option value="adjustment">Explicit adjustment</option><option value="ambiguous">Needs classification</option></select>{check("role")}</div>
    </li>
  );
}

export function ReviewStep({ go }: { go: (s: "scan" | "split") => void }) {
  const { receipt: r, setReceipt, addItem, confirmReceipt } = useBill();
  const [showRaw, setShowRaw] = useState(false);
  const totals = computeTotals(r);
  const set = (patch: Partial<typeof r>) => setReceipt((x) => updateReceiptWithEvidence(x, patch));
  const flagged = (f: string) => r.uncertainFields?.includes(f);
  const mismatch = totals.ok ? totals.value.mismatchCents : null;
  const canContinue = assessReceipt(r).status === "Ready";
  const rowReview = rowReviewState(r);
  const check = (field: ReceiptField, label: string) => <><EvidenceNote evidence={r.evidence?.[field]} />{r.evidence?.[field]?.needsReview !== false && <Button size="sm" variant="outline" onClick={() => confirmReceipt(field)}>{label}</Button>}</>;
  const invalidRate = (field: "serviceRateBp" | "gstRateBp") => setReceipt(x => ({ ...x, evidence: { ...x.evidence, [field]: makeEvidence("unknown", x.evidence?.[field]?.sources, ["Enter a valid rate."]) } }));

  return (
    <Shell step="review" footer={
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <Button variant="outline" onClick={() => go("scan")}>Back</Button>
        <Button disabled={!canContinue} onClick={() => go("split")}>Continue to split</Button>
      </div>
    }>
      <h1 className="text-2xl font-bold">Review receipt</h1>
      <ReceiptStatus receipt={r} />
      {r.ocrWarnings && r.ocrWarnings.length > 0 && (
        <Notice tone="warning" title="Check the scanned details">
          <ul className="list-disc pl-4">{r.ocrWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Notice>
      )}

      <Card>
        <p className="text-sm">Currency: {r.currency}</p>{check("currency", `Confirm currency ${r.currency}`)}
        <Label htmlFor="merchant">Merchant{flagged("merchant") && <span className="ml-1 rounded bg-warning px-1 text-xs text-warning-foreground">check</span>}</Label>
        <input id="merchant" className="field-input" value={r.merchant} maxLength={60} placeholder="Restaurant name" onChange={(e) => set({ merchant: sanitizeText(e.target.value, 60) })} />
      </Card>

      <ReviewConfirmations receipt={r} onChangeReceipt={next => setReceipt(() => next)} />

      {r.rows?.some(row => row.needsReview || row.role === "ambiguous") && <Card className="space-y-3">
        <h2 className="font-semibold">Receipt rows needing a check</h2>
        <p className="text-xs">Check the original receipt. Enter any missing product or adjustment above before marking its row reviewed. Classifying a row does not add its amount to the bill.</p>
        {r.rows.filter(row => row.needsReview || row.role === "ambiguous").map(row => <div key={row.id} className="rounded border p-2">
          <pre className="whitespace-pre-wrap text-xs">{row.text}</pre>
          <Label htmlFor={`row-class-${row.id}`}>Confirm this row's role</Label>
          <select id={`row-class-${row.id}`} className="field-input" value="" onChange={event => {
            const role = event.target.value as typeof row.role;
            if (!role) return;
            set({ rows: r.rows!.map(current => current.id !== row.id ? current : { ...current, role, needsReview: role === "ambiguous", sources: [...current.sources, { kind: "user", text: "User reviewed row association and entered any needed item separately.", observedValue: role }] }) });
          }}><option value="">Choose after checking</option><option value="product">Product already entered above</option><option value="adjustment">Adjustment already accounted for above</option><option value="heading">Heading or non-financial description</option><option value="summary">Informational summary</option><option value="payment">Payment or tender</option><option value="rounding">Bill rounding checked below</option><option value="ambiguous">Still unresolved</option></select>
        </div>)}
      </Card>}

      {rowReview.independentNeedsReview && <Card className="space-y-3">
        <h2 className="font-semibold">Retained row evidence needs a check</h2>
        <p className="text-xs">Check the original receipt and the retained source, layout or association warning. This is separate from individual row classifications.</p>
        <EvidenceNote evidence={rowReview.evidence} />
        <Button variant="outline" disabled={rowReview.unresolvedRows} onClick={() => confirmReceipt("rows")}>I checked the retained row evidence</Button>
        {rowReview.unresolvedRows && <p className="text-xs">Resolve the highlighted individual rows first.</p>}
      </Card>}

      <Card className="space-y-3">
        <div>
          <h2 className="font-semibold">Items</h2>
          <p className="text-xs text-muted-foreground">Enter the <strong>line total</strong> — the price for the whole quantity, as printed on the right of the receipt. Not the unit price.</p>
        </div>
        <ul className="space-y-2">{r.items.map((it, i) => <ItemRow key={it.id} item={it} index={i} />)}</ul>
        <Button variant="secondary" block onClick={addItem}><Plus className="h-5 w-5" aria-hidden /> Add item</Button>
      </Card>

      <QuantityReview receipt={r} onChangeReceipt={next => setReceipt(() => next)} />

      <Card className="space-y-3">
        <h2 className="font-semibold">Discount & charges <span className="text-sm font-normal text-muted-foreground">(SGD)</span></h2>
        <MoneyInput label="Bill discount" hint="(optional)" value={r.discountCents} onChange={(c) => c === null ? setReceipt(x => ({ ...x, discountCents: 0, evidence: { ...x.evidence, discountCents: makeEvidence("unknown", x.evidence?.discountCents?.sources, ["Enter the discount, or confirm that there is none."]) } })) : set({ discountCents: c })} />
        {check("discountCents", "Confirm discount or no discount")}
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
            ? <><RateInput key="svc" label="Service rate" bp={r.serviceRateBp} onChange={(bp) => set({ serviceRateBp: bp })} onInvalid={() => invalidRate("serviceRateBp")} />{check("serviceRateBp", "Confirm service rate")}</>
            : <MoneyInput label="Service charge amount" value={r.serviceAmountCents} onChange={(c) => set({ serviceAmountCents: c })} />)}
          {check("service", "Confirm service charge or none")}
        </div>

        <div className="rounded-lg border border-border p-3">
          <Toggle label="GST" checked={r.gstEnabled} onChange={(v) => set({ gstEnabled: v })} />
          {r.gstEnabled && (
            <div className="space-y-2">
              <Toggle label="Prices already include GST" description="GST is shown for information only and not added again." checked={r.gstInclusive} onChange={(v) => set({ gstInclusive: v })} />
              {check("gstInclusive", "Confirm GST included or added")}
              {r.chargeMode === "percentage"
                ? <><RateInput key="gst" label="GST rate" bp={r.gstRateBp} onChange={(bp) => set({ gstRateBp: bp })} onInvalid={() => invalidRate("gstRateBp")} />{check("gstRateBp", "Confirm GST rate")}</>
                : <MoneyInput label={r.gstInclusive ? "GST included (from receipt)" : "GST amount"} value={r.gstAmountCents} onChange={(c) => set({ gstAmountCents: c })} />}
            </div>
          )}
          {check("gst", "Confirm GST amount or none")}
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Totals</h2>
        <div className="rounded border p-3 space-y-2">
          <MoneyInput label="Bill rounding adjustment" allowNegative hint="(signed final adjustment, after GST)" value={r.roundingAdjustmentCents ?? null} onChange={c => set({ roundingAdjustmentCents: c, roundingApplied: false })} />
          <EvidenceNote evidence={r.evidence?.rounding} />
          {r.roundingAdjustmentCents != null && !r.roundingApplied && <Button variant="outline" onClick={() => setReceipt(current => {
            const next = updateReceiptWithEvidence(current, { roundingApplied: true });
            return reconcileRowReviewEvidence({ ...next, rows: next.rows?.map(row => row.role !== "rounding" ? row : { ...row, needsReview: false, sources: [...row.sources, { kind: "user", text: "User checked the final bill adjustment and applied the entered signed amount once.", observedValue: next.roundingAdjustmentCents ?? null }] }) });
          })}>I checked this rounding amount; apply it once</Button>}
          <p className="text-xs">Rounding never comes from a total difference. Larger, repeated or ambiguous printed adjustments require checking. It does not change GST or the tax base.</p>
        </div>
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
            {totals.value.unroundedTotalCents !== undefined && <><Row k="Calculated total before rounding" v={totals.value.unroundedTotalCents} /><Row k="Bill rounding" v={totals.value.roundingCents ?? 0} /></>}
            <div className="flex justify-between border-t border-border pt-2 text-base font-bold"><dt>Calculated payable total</dt><dd className="money">{formatMoney(totals.value.totalCents)}</dd></div>
            {r.gstEnabled && r.gstInclusive && <Row k="incl. GST (not added)" v={totals.value.gstIncludedCents} muted />}
          </dl>
        ) : (
          <Notice tone="error"><ul className="list-disc pl-4">{totals.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Notice>
        )}
        <MoneyInput label="Receipt total" allowNegative hint="(grand total printed on receipt)" flagged={flagged("total")} value={r.receiptTotalCents} onChange={(c) => set({ receiptTotalCents: c })} />
        {check("total", r.receiptTotalCents === null ? "Confirm no printed total is available" : "Confirm printed total")}
        {r.suggestedTotalCents != null && <Notice tone="warning" title="Suggested payable total">
          <p>{formatMoney(r.suggestedTotalCents)} is inferred from payment context. It is separate from the printed and calculated totals.</p>
          <EvidenceNote evidence={r.evidence?.suggestedTotal} />
        </Notice>}
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

