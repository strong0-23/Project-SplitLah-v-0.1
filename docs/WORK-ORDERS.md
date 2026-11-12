# Work orders

This file is the queue of work for Claude Code on SplitLah. The coordinator (Claude in the owner's
planning chat) writes it after decisions are made. Claude Code reads it and carries out the work
without asking for confirmation.

**Claude Code: if you were started with no specific task, or told to "run the queue", do what this
file says, starting at "How to run the queue". If the owner gave you a different task, do that
task and leave the queue alone.**

## Roles

| Who | Does | Does not |
|---|---|---|
| Owner | Sets direction, tests on real devices, hears about major changes | Review every PR |
| Coordinator | Writes work orders, verifies each PR independently, merges, edits this file | Write the feature code |
| Claude Code | Executes one work order per branch and PR, writes its report | Merge, push to `main`, edit this file |

Only the coordinator edits this file. That keeps one writer and avoids merge conflicts between
work orders. Your results go in your report and your PR description.

## Standing rules

These apply to every work order. `AGENTS.md`, `docs/DECISIONS.md` and `docs/MODULES.md` hold the
detail; read them before you start.

1. **Never push to `main`, never merge, never rewrite pushed history** (no force-push, rebase,
   amend or squash of pushed commits). Push only your work-order branch and open a PR.
2. **Recognition stays on the device.** No image uploads, no cloud OCR or vision API.
3. **Tesseract is the only engine.** Do not add an engine or tune Tesseract's own parameters
   unless a work order says so.
4. **Private receipt data never enters git.** Photos, OCR text, item names, shop names, card
   numbers, people's names and amounts from real receipts stay out of commits, PRs, reports and
   test fixtures. Tests use invented text only. Reports give receipt IDs and counts only.
5. **Held-out receipts are never read.** Development receipts may be read for local diagnosis.
   Their folder is given by the environment variable `SPLITLAH_DEV_RECEIPTS` or in your launch
   prompt. If you have no such folder, do the synthetic parts, say so in the report, and stop
   short of claiming measured results.
6. **No change to the storage schema, to an established interface or to the dependencies**
   unless the work order lists it as approved. If you find you need one, see "When to stop".
7. **Money is integer cents.** Financial logic stays in pure functions. Keep the module boundaries
   in `docs/MODULES.md`: pure modules import no DOM, SDK or UI code.
8. **Never silent.** A change that hides, drops or reinterprets something on a receipt must leave
   a visible trace on the review screen.
9. **General rules only.** A fix must rest on how receipts are structured, never on one shop's
   name, wording or layout. If a rule would only help one development receipt, do not add it.
10. **Never claim a check you did not run.**

## How to run the queue

1. `git fetch origin`. Read this file on `origin/main`, not a stale copy.
2. Take the first work order under "Queue" whose status is `open`, in order. Skip one whose branch
   already exists on the remote (`git ls-remote --heads origin 'wo/NNN-*'`); it is in review.
3. Create its branch from the latest `origin/main`, with the branch name the work order gives.
4. Do the work. Keep changes small and inside the modules the work order names. If you need to
   touch another module, say why in the report.
5. Run every check under "Checks". Fix what you broke.
6. Write the report at the path the work order gives. Update `docs/DECISIONS.md` (new rules, with
   the decision ID the work order assigns), `docs/MODULES.md` and `AGENTS.md` where they changed.
7. Push the branch and open a PR titled `WO-NNN: <title>`. The PR description gives: what changed,
   the before/after numbers, checks run and not run, known limits, and any "Decision needed".
8. Go on to the next `open` work order, unless it lists a dependency that is not merged yet.
   When none is left, stop and give a short summary of the PRs you opened.

Commit messages: one line saying what changed, a short body when useful. End them with the
attribution lines your session gives you.

## Checks

Run all of these before opening the PR and list the results in the report.

| Check | Command |
|---|---|
| Types, app | `npx tsc --noEmit` |
| Types, harness | `npm run receipts:check` |
| App tests | `npm run test` |
| Harness tests | `npm run receipts:test` |
| Production build | `npm run build` |
| Deploy config | `npx wrangler@4.154.0 deploy --dry-run --config cloudflare/wrangler.jsonc` |
| Scan → review → split, headless | `tools/receipt-regression/smoke/review-smoke.mjs` (its header says how) |
| Lint on the files you touched | `npx eslint <those files>` (full `npm run lint` once WO-003 is merged) |
| No private data | search your diff for real shop names, item names and card digits before every push |

When a work order asks for before/after numbers, measure `origin/main` and your branch the same
way, on the same development receipts, in the same browser, and report both.

## When to stop

Stop work on the affected part, finish the rest, and put a **Decision needed** section at the top
of the PR description when:

- the work needs a new or changed dependency, a storage schema change or a change to an
  established interface that the work order did not approve;
- two standing rules or two recorded decisions conflict;
- the fix would lower a security control, or raise the first-scan or warm-scan time past the limit
  the work order sets;
- any development receipt gets worse on corrections or silent errors and you cannot remove the
  regression;
- the measured result does not meet the work order's acceptance line. Report the real numbers; do
  not tune rules to one receipt to reach the line.

Say what the choice is, what you recommend and why, in a few plain sentences.

## Queue

### WO-001: Stop losing printed text before the parser sees it

- **Status:** open
- **Branch:** `wo/001-reading-coverage`
- **Report:** `docs/reports/2026-11-wo001-reading-coverage.md`
- **Decision ID for new rules:** D14

**Why.** The owner's hand-test of Batch 3 (12 Nov 2026) found receipts where no row was read
correctly and the hidden-lines helper never appeared. The stored headless readings show the cause
is upstream of the parser, on receipts that are clean and easy for a person to read. On one, the
reading stops after the first item row and most of the paper is never read. On another, the left
edge of every line is cut off. On a third, rows come out scrambled. The parser and the total
anchor cannot recover text that never arrives, and the anchor needs exact amounts, so it stays
silent on those receipts.

This is work on our own image preparation, not on the engine: `image.ts`, `canvas.ts`, `scan.ts`.

**Scope.**

1. **Measurement first.** Add a headless development runner to `tools/receipt-regression`
   (dev-only, refuses production builds, like the rest of the harness). Input: the private folder.
   Output: receipt IDs and counts only. For each receipt it reports:
   - *reading coverage*: the share of the reference's printed amounts (item amounts, charges,
     printed total) that appear anywhere in the OCR text;
   - the corrections count and silent errors, scored as in the engine comparison
     (`name-match=recognisable-0.70`);
   - first-scan time.
   A private runner from Batch 3 may exist in your environment; use it as the starting point if
   so. Nothing private is written into the repo.
2. **Find where the text is lost**, stage by stage, for every receipt under 90% coverage:
   orientation choice, `autoCrop` / `detectPaperBounds`, `flattenCanvas` / `flattenIllumination`,
   the recognition pass, the second-pass choice. Write intermediate images to a private folder
   outside the repo and look at them. Record, per receipt ID, which stage loses the text.
3. **Fix the stages that lose text, with general rules.** Likely candidates, to be confirmed by
   step 2 and not assumed:
   - a crop that cuts into the paper: the crop must never remove text. Add a margin and a safety
     check (if ink-like content touches the crop edge, widen or drop the crop);
   - uneven light, shadow bands and colour casts: flattening that holds up across a shadow edge,
     and a sensible channel or grey conversion under a colour cast;
   - an upside-down or sideways choice on a receipt that is upright;
   - a second pass that replaces a fuller first reading with a shorter one. Prefer the reading
     that covers more of the page, and consider merging lines the two passes disagree on only if
     that stays simple.
   Pure logic goes in `image.ts` with unit tests on small synthetic pixel arrays; `canvas.ts`
   stays a thin adapter.
4. **Tell the user when a reading looks incomplete.** If the reading covers much less of the
   paper than the paper's printed area suggests (for example text stops well above the bottom of
   the detected paper, or no total was read), show a plain warning on the review screen: the photo
   was only partly read, retake it or add the missing items. Derive it; store nothing new (D13).

**Not in scope.** A new engine, Tesseract parameter changes, new dependencies, parser rules.

**Acceptance.**

- Reading coverage, median across the development receipts, goes up, and no receipt's coverage
  goes down by more than 5 points.
- No receipt gets worse on corrections or silent errors.
- Receipts within 2 corrections: report before and after. Target 6 of 12 or better; 4 of 12 is
  today's figure.
- First-scan median rises by no more than 1.0 s over `origin/main` in the same browser.
- Synthetic tests cover each fix, including a negative test (a crop that would cut text is
  refused; an even-lit image is left unchanged within tolerance).

### WO-002: Quantity confirmed by the receipt's printed item count

- **Status:** open
- **Branch:** `wo/002-quantity-by-item-count`
- **Report:** `docs/reports/2026-11-wo002-quantity-by-item-count.md`
- **Decision ID for the rule:** D15 (approved under the owner's delegation, 12 Nov 2026)

**Why.** Under D7 a bare number next to an item name is a quantity only under a Qty heading or
when unit price × number equals the line total. When OCR damages the heading and no unit price is
printed, real quantities stay inside the names. Batch 3 measured this as the largest single
remaining cause of corrections that the parser can fix (12 corrections on the development set).

**Rule D15.** Many receipts print how many items were sold ("Total Qty 7", "Total 5 items",
"Items: 3", "No. of items 4"). When such a count was read:

1. Collect the item rows that carry exactly one unresolved bare whole number from 1 to 99, at the
   start of the name or at its end (after a per-item tax marker if there is one). These are the
   rows D7 leaves flagged today.
2. Try one assignment only: every such row takes its number as the quantity, every other row
   keeps the quantity it already has (1 when none was read).
3. If the quantities then add up to the printed count exactly, apply it: the numbers become
   quantities, leave the names, and the D7 flag on those rows is cleared. Line totals do not change.
4. Otherwise change nothing. That includes: no count read, the count is not a whole number, a row
   has numbers at both ends, any row's line total is missing, or the sum is off by even one.
5. An explicit quantity ("2 x", "x2", "2 @") and D7's own two tests always win over D15.

The rule is all-or-nothing on purpose. It must never take some of the numbers.

**Scope.** `lexicon.ts` (the item-count wording, with its delimiters, in the languages the lexicon
already covers), `items.ts` / `parse.ts` (the rule), `review.ts` only if a row reason changes.
Synthetic tests: the count before and after the items, a tax marker between name and number,
leading numbers, mixed rows, and negatives (product names that end in a number such as a size or
a model, with a count that does not match; a count that matches only if some numbers are taken).

**Acceptance.**

- All existing tests pass; the three D7 expectations ("2 Pancakes", "Pad Thai 2", "Nasi Goreng 2")
  still hold when no item count is printed.
- On the development receipts: no receipt worse on corrections or silent errors; report the
  change in wrong-quantity and name corrections.
- No wrong quantity is introduced on any development receipt.

### WO-003: Make `npm run lint` usable

- **Status:** open
- **Branch:** `wo/003-lint`
- **Report:** none; describe it in the PR.

**Why.** `npm run lint` crashes on `main`. It lints the bundled Tesseract files under
`public/tesseract` and local Wrangler caches, and the original app files were never formatted.

**Scope.**

1. In `eslint.config.js`, ignore `public/tesseract/**`, `.wrangler/**` and `cloudflare/.wrangler/**`.
2. In one separate commit, run Prettier on the files that still fail, formatting only. No logic
   edits in that commit.
3. Fix the single `no-control-regex` error in `src/hooks/use-bill.tsx` without changing what the
   expression matches, with a test if none covers it.

**Acceptance.** `npm run lint` finishes with 0 errors. All checks pass. The formatting commit
changes no behaviour: tests, type checks and build pass before and after.

## Done

| Work | PR | Merged | Result |
|---|---|---|---|
| Batch 1, 1a, 1b: scanner rework and real-receipt fixes | #2 | 8 Nov 2026 | Scored gate passed |
| Batch D: Cloudflare deploy | #3 | 11 Nov 2026 | Live on Workers |
| Paddle adapter, canvas check, CSP, comparison harness, name matching | #4 to #8 | 11 Nov 2026 | Comparison run |
| Paddle removal | #9 | 12 Nov 2026 | Tesseract is the only engine |
| Batch 3: structure + review | #10 | 12 Nov 2026 | Within 2 corrections 2/12 → 4/12 on the development set |
