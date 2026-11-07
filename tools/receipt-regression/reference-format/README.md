# Verified reference format (owner-inventory)

This is the format of the owner's verified references (`*.reference.private.json`). They live only in the
git-ignored `receipt-regression.local/` on the owner's PC and are never committed.

- `reference-template.json`: a blank template. Every field is `not_yet_verified`, with no values.
- `reference-contract.mjs`: the validator for that format, unchanged from the owner's local tooling.
  It returns paths and codes only, never values.

Key rules:
- Each field is `{ state, value | value_cents | quantity…, evidence }`.
- `state` is one of `known`, `not_printed`, `illegible`, `not_applicable` or `not_yet_verified`.
- Only `known` fields carry a value and count for scoring.
- `unknownReferenceCredit: false` means a field that isn't known never earns or loses points.
- Money is integer cents, and quantities are exact rationals (`{ numerator, denominator }`).

The two files were copied from the owner's PC on 8 Nov 2026 after checking that they contain no receipt data.
