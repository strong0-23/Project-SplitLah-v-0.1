# Baseline: parser-v2 parser (read-only)

Verbatim copies of these files from branch `parser-v2`, commit a80f7e3 (`src/lib/`):
`bill.ts`, `defaults.ts`, `ids.ts`, `money.ts`, `parser.ts`, `quantity-defaults.ts`, `quantity.ts`,
`receipt-quality.ts`, `receipt-rounding.ts`, `types.ts`. This is the dependency closure of
`parseReceiptText` and `computeTotals`; it imports nothing outside this folder.

Used only by the local receipt-regression harness as the baseline the rework parser must match or
beat (Batch 1b merge gate). The app never imports it, it is excluded from ESLint, and it must not
be edited: re-copy from the branch if the baseline ever needs to change, and record the commit here.
