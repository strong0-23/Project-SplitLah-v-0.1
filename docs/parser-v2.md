# Parser v2 candidate

This uncommitted candidate is isolated from the working scanner. No OCR engine,
model, image preprocessing or scan timeout is replaced. It changes interpretation
and review, so it can affect OCR scoring, retries, selection and regional requests.
The existing `scoreParse` weights are unchanged; its inputs (rows, prices and flags)
are not. A saved reading cannot supply a new retry that was never captured.

## Evidence and review

Each relevant field carries observed, calculated, inferred, defaulted,
user-confirmed or unknown provenance, sources and its own review reasons. User
edits confirm only the affected fields; earlier recognition evidence survives.
Consecutive user actions are coalesced to bound edit history. Source evidence is
structured data; images are never persisted. Stored schema v1 values migrate to
v2 with unknown provenance and require review.

The numeric `quantity` member remains for older callers. `quantityExact: null`
means unknown, including when that compatibility number happens to be 1. Review
shows a blank quantity, and the regression evaluator does not count it as known.
Application currency/rate preferences do not establish receipt observations.

**Ready** requires product identity, a confirmed/observed exact nonzero quantity,
known full line amounts, valid row roles/pricing relationships, currency,
discount/charge decisions (including checked absence), relevant tax mode/rates,
resolved row associations, and a checked printed total or explicit confirmation
that it is unavailable. Any available printed total must reconcile exactly.
Merchant name and an absent optional unit price are not required for splitting.
Review, Split and Summary gate progression using the same assessment.

**Needs check** lists affected fields even when arithmetic balances. **Failed**
distinguishes an interrupted/failed runtime from extraction without a usable
product and known line amount. Insufficient extraction remains editable, with
retained rows. Runtime scan errors retain their useful explanation on Scan.

## Exact financial relationships

Money is signed integer cents; rates are basis points. Quantities are reduced
rationals, not rounded display decimals. Quantity × unit price / price basis uses
BigInt arithmetic and rounds once, half up to a cent (ties away from zero).
There is no reconciliation tolerance and no manufactured balancing adjustment.
Compatible g/kg and ml/l conversions and exact fractional quantities are allowed.
Returns and explicitly classified signed adjustments are represented separately
from purchases. Quantity-based allocation requires a confirmed positive integer;
single/even/custom allocation supports signed credits. Refund-only charge/tax
allocation and unsupported unit conversions remain explicit limitations.

An item discount already included in **both** prices permits the exact relationship
check. A gross unit price and net line amount without an independently identified
adjustment remain unresolved. The price-basis editor cannot waive a mismatch.

Only change 1b can suggest missing quantities. It requires independently identified
unit and full-line prices on the same product, compatible explicit basis, exact
integer division and no unresolved discount, adjustment or tax basis. The result
remains inferred, labelled “auto-filled, please check” and requires confirmation.
It never derives a missing price from a payable total.

## Interpretation and adapters

Finite label-only normalisation handles I/l/1/|, O/0 and S/5. It does not repair
amount digits or product names. Full summary-label grammar protects products
containing summary words. Numeric identifiers and package sizes remain in names;
explicit column order and supported adjacent numeric rows establish associations.
Ambiguous rows are retained rather than discarded after the first total.

Purchased offers, offer descriptions, signed adjustments and savings summaries
have separate roles. A savings summary alone is informational. An independently
signed offer adjustment needs supporting adjacent product evidence and remains
flagged. An unexplained difference stays a discrepancy. Negative tax/service
amounts are retained for review rather than made positive charges.

Printed payable total, computed bill total and payment-derived suggested total
are separate fields. Split/mixed tender, cash/change, conflicting signs and
conflicting totals cannot silently establish independent confirmation. Recovered
alternate totals retain the source attempt and require review.

`RecognitionDocument` is the common text/geometry/source contract.
`documentFromTesseract` preserves exact selected text and native 0–100 confidence;
optional words do not invent a word-to-line mapping. `documentFromPaddle` accepts
the existing geometry adapter's reading order and indexed boxes with native 0–1
confidence. These scores are not compared. `parseRecognitionDocument` applies
the same financial parser, binds engine/attempt/box sources and propagates relevant
layout uncertainty. Adapters contain no receipt financial rules or expected answers.
This contract is covered with synthetic inputs; it does not constitute a new
Paddle browser evaluation or a recommendation to replace Tesseract.

## Validation and private material

Application tests are synthetic. Existing private captures/references and detailed
replay reports remain in ignored `receipt-regression.local`; only a local non-LLM
runner reads them and emits sanitised counts/technical diagnostics. They are not
production assets. Existing four-receipt evidence is regression evidence, not an
independent engine evaluation. The approved blank reference template and annotation
guide do not authorise opening held-out content or deriving references from OCR.

Batch 1 supplies separate safety and interpretation diffs with a detailed private
validation report. Batch 2 requires the independently labelled evaluation set,
layout-based split, declared configurations/budgets and a final freeze first.
