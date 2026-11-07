import { useState } from "react";
import { confirmPrintedChargeFields, eligiblePrintedChargeConfirmations } from "@/lib/review-confirmation";
import { eligiblePreferenceValues, loadSavedPreferences, mergeConfirmedPreferences, savedPreferenceConflicts, writeSavedPreferences } from "@/lib/preferences";
import { confirmReceiptField } from "@/lib/receipt-quality";
import type { PrintedChargeField } from "@/lib/review-confirmation";
import type { PreferenceKey } from "@/lib/preferences";
import type { Receipt } from "@/lib/types";
import { Button, Card, Notice } from "./ui";

export interface ReviewConfirmationAction {
  type: "printed-charge-confirmation" | "preference-conflict-confirmation" | "save-preferences" | "decline-preferences";
  fields: string[];
  fieldActions: number;
  interactions: number;
}

/** The separate receipt marker preserves the single optional offer across review remounts. */
export function ReviewConfirmations({ receipt, onChangeReceipt, onAction }: {
  receipt: Receipt;
  onChangeReceipt: (receipt: Receipt) => void;
  onAction?: ((action: ReviewConfirmationAction) => void) | undefined;
}) {
  const charges = eligiblePrintedChargeConfirmations(receipt);
  const preferences = eligiblePreferenceValues(receipt);
  const conflicts = savedPreferenceConflicts(receipt);
  const [selectedCharges, setSelectedCharges] = useState<PrintedChargeField[]>(() => charges.map(candidate => candidate.field));
  const [excludedPreferences, setExcludedPreferences] = useState<PreferenceKey[]>([]);
  const [promptComplete, setPromptComplete] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const selected = charges.filter(candidate => selectedCharges.includes(candidate.field));
  const selectedPreferences = preferences.filter(candidate => !excludedPreferences.includes(candidate.key));
  const noteSelection = (fields: string[]) => onAction?.({ type: "printed-charge-confirmation", fields, fieldActions: 0, interactions: 1 });

  return <>
    {conflicts.length > 0 && <Card className="space-y-3">
      <h2 className="font-semibold">Receipt values differ from saved defaults</h2>
      <p className="text-sm">The receipt values have been retained. Check each difference against the receipt before confirming. This does not change your saved defaults or establish that a charge applies.</p>
      {conflicts.map(conflict => <div key={conflict.key} className="space-y-2 rounded border p-2">
        <p>{conflict.label}: receipt <strong>{conflict.receiptValueLabel}</strong>; saved default <strong>{conflict.savedValueLabel}</strong>.</p>
        <Button variant="outline" onClick={() => {
          onChangeReceipt(confirmReceiptField(receipt, conflict.key));
          onAction?.({ type: "preference-conflict-confirmation", fields: [conflict.key], fieldActions: 1, interactions: 1 });
        }}>Confirm receipt {conflict.label.toLowerCase()} {conflict.receiptValueLabel}</Button>
      </div>)}
    </Card>}
    {charges.length > 0 && <Card className="space-y-3">
      <h2 className="font-semibold">Confirm printed charge details together</h2>
      <p className="text-sm">Check the receipt, then select the independently readable printed fields below. Unknown, inferred, conflicting and saved-preference fields remain for individual review.</p>
      <ul className="space-y-2">{charges.map(candidate => <li key={candidate.field}>
        <label className="flex items-start gap-2"><input type="checkbox" checked={selectedCharges.includes(candidate.field)} onChange={event => {
          setSelectedCharges(previous => event.target.checked ? [...previous, candidate.field] : previous.filter(field => field !== candidate.field));
          noteSelection([candidate.field]);
        }} /><span>{candidate.label}: <strong>{candidate.valueLabel}</strong></span></label>
        <details className="ml-6 text-xs"><summary>Printed evidence for {candidate.label.toLowerCase()}</summary>
          {candidate.sources.filter(source => source.kind === "text" || source.kind === "geometry").map((source, index) => <pre key={index} className="whitespace-pre-wrap">{source.text}</pre>)}
        </details>
      </li>)}</ul>
      <Button variant="outline" disabled={selected.length === 0} onClick={() => {
        const result = confirmPrintedChargeFields(receipt, selected.map(candidate => candidate.field));
        if (!result.confirmedFields.length) return;
        onChangeReceipt(result.receipt);
        onAction?.({ type: "printed-charge-confirmation", fields: result.confirmedFields, fieldActions: result.fieldActions, interactions: 1 });
      }}>Confirm {selected.length} selected charge field{selected.length === 1 ? "" : "s"}</Button>
      <p className="text-xs">One click confirms {selected.length} separate field{selected.length === 1 ? "" : "s"}. Original receipt evidence is retained.</p>
    </Card>}

    {!promptComplete && !receipt.preferencePromptHandled && preferences.length > 0 && <Card className="space-y-3">
      <h2 className="font-semibold">Save these as your defaults?</h2>
      <p className="text-sm">Only values you have individually confirmed are listed. Saved defaults remain preferences; they do not establish charges, GST inclusion or applicability on another receipt.</p>
      <ul className="space-y-2">{preferences.map(candidate => <li key={candidate.key}><label className="flex items-center gap-2">
        <input type="checkbox" checked={!excludedPreferences.includes(candidate.key)} onChange={event => {
          setExcludedPreferences(previous => event.target.checked ? previous.filter(key => key !== candidate.key) : [...previous, candidate.key]);
          onAction?.({ type: "save-preferences", fields: [candidate.key], fieldActions: 0, interactions: 1 });
        }} />{candidate.label}: <strong>{candidate.valueLabel}</strong>
      </label></li>)}</ul>
      {saveError && <Notice tone="error">Defaults could not be saved in this browser. You can keep reviewing without saving.</Notice>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={selectedPreferences.length === 0} onClick={() => {
        const result = mergeConfirmedPreferences(receipt, selectedPreferences.map(candidate => candidate.key), loadSavedPreferences(), new Date().toISOString());
        if (!result.savedKeys.length || !writeSavedPreferences(result.preferences)) { setSaveError(true); return; }
        setPromptComplete(true);
        onChangeReceipt({ ...receipt, preferencePromptHandled: true });
        onAction?.({ type: "save-preferences", fields: result.savedKeys, fieldActions: 0, interactions: 1 });
      }}>Save selected defaults</Button>
      <Button variant="ghost" onClick={() => {
        setPromptComplete(true);
        onChangeReceipt({ ...receipt, preferencePromptHandled: true });
        onAction?.({ type: "decline-preferences", fields: [], fieldActions: 0, interactions: 1 });
      }}>Not now</Button></div>
      <p className="text-xs">This choice is optional and does not change the current receipt.</p>
    </Card>}
  </>;
}
