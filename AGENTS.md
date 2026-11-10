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
- Receipt scanning lives in the feature module `src/lib/scan/*`; UI imports `@/lib/scan` (its `index.ts`) only. See docs/MODULES.md for the module table and docs/DECISIONS.md for scanner decisions D1–D6.
  - Pure modules (no DOM, no SDK, unit-tested with synthetic text): `types.ts` (contracts), `image.ts`, `layout.ts`, `numbers.ts`, `lexicon.ts`, `items.ts`, `reconcile.ts`, `parse.ts`.
  - Adapters: `canvas.ts` (browser canvas) and `tesseract-engine.ts` (OCR SDK). `scan.ts` is the workflow (decode → load → orient → recognise → optional 2nd pass), cancellable and time-bounded, with the engine injected.
  - OCR engines sit behind the `OcrEngine` interface in `types.ts` (load / recognize / terminate, word boxes out). Tesseract is the default; another on-device engine is added as a new adapter with no parser change. Recognition stays on the device: never upload images or add a cloud OCR/vision API.
  - Receipt vocabulary (charge, tax, total, payment terms) goes in `lexicon.ts`, not the parser.
- Scanning (src/lib/scan), persistence (src/lib/storage.ts) and state (src/hooks/use-bill.tsx) stay separate modules; only structured, schema-versioned data is persisted — never images.
- Wizard step lives in the `?step=` search param so browser back/forward works while edits persist in shared state.
- Tesseract.js is dynamically imported inside the Tesseract adapter's `load` (src/lib/scan/tesseract-engine.ts) so it never enters the SSR/initial bundle.
- Deploy: Cloudflare Workers via Workers Builds (docs/DEPLOY.md). The Wrangler config is `cloudflare/wrangler.jsonc`, used with `--config`; do not move it to the repo root, where nitro would merge it into Lovable's build. Security headers (src/lib/security-headers.ts, applied in src/server.ts) are on only when the Worker var `SPLITLAH_SECURITY_HEADERS` is "on"; keep the CSP compatible with on-device OCR (blob: workers, 'wasm-unsafe-eval', model files).
