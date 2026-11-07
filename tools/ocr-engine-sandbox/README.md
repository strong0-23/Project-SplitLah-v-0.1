# Isolated local OCR engine comparison

This dev-only sandbox compares a frozen copy of the current working Tesseract pipeline with the official PaddleOCR browser SDK. It does not modify the default scanner, parser, root dependencies or stored bills. No cloud OCR or receipt upload is used. See [PROVENANCE.md](./PROVENANCE.md) for package/model identity, licensing, pins and browser limitations.

The control snapshot, photos, verified answers, raw text/boxes and generated reports live only under the Git-ignored `receipt-regression.local/` directory. Keep them out of `public/`, `src/` and committed examples. The loopback server exposes only sandbox code, frozen library code and explicitly whitelisted public engine assets. Dataset images and reports are read by the Node runner and passed into browser memory through loopback CDP; there is no image-serving/upload route.

## Existing experiment

The current control is already frozen. Do not run the freeze command again or overwrite it. Its `control-freeze.json` records the working source hashes, Git status/HEAD, installed versions, settings and historical baseline runtime. `control-source/` includes uncommitted source bytes and `control-working-diff.patch` records the tracked diff. Reports record the actual comparison browser runtime and image hashes independently.

The final local comparison uses `control-cold.json`, `paddle-960-cold.json` and `paddle-1920.json`. The `tooling-probe-*` files are failed runner setup probes, not OCR quality results. They are retained separately. `comparison.local.json` is an evaluation-only summary. Reference answers never enter recognition or box adaptation.

## Reproducing locally

Use PowerShell and `npm.cmd`. Do not restart the application's dashboard. These commands use a different port and a dedicated browser profile.

For a **new** experiment with no existing frozen control:

```powershell
node tools/ocr-engine-sandbox/freeze-control.mjs <private-baseline.json> <private-dataset-folder>
npm.cmd ci --prefix tools/ocr-engine-sandbox --ignore-scripts --no-audit --no-fund
node tools/ocr-engine-sandbox/prepare-assets.mjs
```

Run the separate server from the repository root:

```powershell
node node_modules/vite/bin/vite.js --config tools/ocr-engine-sandbox/vite.config.ts
```

It binds **http://127.0.0.1:8082/** and refuses production builds. Launch installed Edge in a dedicated headless profile, with loopback debugging port 9333. Do not enable remote debugging on your personal browser profile. The supplied runner expects one dedicated blank/sandbox page and this debugging port. In a separate terminal, the following runs are sequential:

```powershell
node tools/ocr-engine-sandbox/run.mjs <private-dataset-folder/> control --cold
node tools/ocr-engine-sandbox/run.mjs <private-dataset-folder/> paddle-960 --cold
node tools/ocr-engine-sandbox/run.mjs <private-dataset-folder/> paddle-1920
node tools/ocr-engine-sandbox/summarize.mjs <private-dataset-folder/>
```

The dataset uses the existing regression harness format, with four manually verified receipts. Model preparation requires internet only to download public code/model files. During recognition the runner permits loopback GET/HEAD requests and serves pinned assets locally. No credentials are required. `--cold` clears browser HTTP cache and storage for the sandbox origin; it does not measure internet download latency. Scan times include actual preparation/recognition/adapter/parser work; Paddle model initialization is reported separately. The first receipt is not included in the reported subsequent-scan median.

Every result retains raw recognition separately from adapted lines and parsed output, including word/box source information, progress or SDK timings, review flags, errors and runtime. The parser is imported from the frozen snapshot for both engines. The current Tesseract coordinator remains part of the control; Paddle uses one reading per predeclared resolution. A developer must not choose different resolutions for individual receipts based on their expected answers.

`adapter.ts` groups text boxes using only geometry and a shared observed skew. It does not edit recognised characters, add semantic headers or resolve ambiguous row associations. Adapter diagnostics are separate from parser flags. An unflagged parsed item can still be wrong; review actual fields and raw text rather than rewarding fewer flags or more rows.

## Checks

From the repository root:

```powershell
npx.cmd vitest run --config tools/ocr-engine-sandbox/vitest.config.ts
npx.cmd tsc --project tools/ocr-engine-sandbox/tsconfig.json
```

These are synthetic adapter tests, not new photo OCR. The summary command verifies that original working-source bytes, frozen copies, private inputs and evaluated checks are unchanged. Stop at the bounded model/resolution comparison; do not tune the challenger against each receipt. Validate any promising future integration on previously unseen merchant layouts before recommending replacement.
