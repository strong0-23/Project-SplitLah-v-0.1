<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Splitlah architecture
- All money is integer cents and rates are integer basis points; financial logic lives in pure functions in src/lib/bill.ts + money.ts so it can be unit-tested without UI.
- OCR (src/lib/ocr.ts), parsing (src/lib/parser.ts), persistence (src/lib/storage.ts) and state (src/hooks/use-bill.tsx) stay separate modules; only structured, schema-versioned data is persisted — never images.
- Wizard step lives in the `?step=` search param so browser back/forward works while edits persist in shared state.
- Tesseract.js is dynamically imported inside runOcr so it never enters the SSR/initial bundle.
