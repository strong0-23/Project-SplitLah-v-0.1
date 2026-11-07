# Review confirmation and saved preferences

`review-confirmation.ts` filters existing structured evidence. It does not recognise text, repair OCR or fill missing financial values.

The printed-charge bulk action lists service charge, GST, applicable percentage rates and GST treatment separately. A field is eligible only when its origin is observed, its evidence has no outstanding review reason, and independently captured text/geometry names that field and supports the current value. Amounts, rates and inclusion are separate confirmations. Missing text, arithmetic agreement, conflicting values, signed/unreadable charge text, saved preferences and inferred treatment do not qualify. An explicit no-charge statement can support absence; silence cannot.

The button confirms only selected fields, rechecking eligibility at click time. Each field retains its original sources and adds a user action. One bulk click confirming four fields is four field confirmations and one interaction. The optional action callback also records checkbox interactions with zero field confirmations.

`preferences.ts` uses a separate versioned local-storage key. Only currency, GST rate and service-charge rate can be saved. A candidate requires a user-confirmed field with a user-source value matching the current value. Confirming currency never saves untouched rates. The optional prompt lists and allows deselection of every value; saving or declining records only the prompt marker on the receipt. Declining does not block review. The marker prevents repeated offers when Review is reopened for the same receipt.

On a new receipt, saved preferences may prefill only unknown/defaulted settings without receipt-source evidence. They retain `saved-preference` origin and a review requirement. They never set charge presence, charge amounts, calculation mode, GST inclusion or whether a saved rate applies. Observed, inferred, confirmed or conflicting receipt evidence takes precedence.

If an observed or inferred receipt rate differs from a saved preference, keep the receipt value and its origin/sources, append the conflicting preference source, and require individual review. The conflict card lists both values. Confirming the receipt value does not change the saved preference; any later offer to save it remains optional. An already confirmed current-receipt value is not invalidated by a different saved default.

The preference store contains only the allowlisted values and confirmation timestamps. It contains no receipt text, images, reference answers or receipt source records. Saving preferences is optional setup, not an extraction correction or an accuracy pass.
