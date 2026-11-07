import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
const local = 'receipt-regression.local/engine-comparison/';
const datasetFolder = process.argv[2] ?? 'receipt-regression.local/first-four/';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const freeze = await read(local + 'control-freeze.json');
for (const source of freeze.sources) {
  if (hash(await readFile(source.path)) !== source.sha256) throw new Error('Original working source changed: ' + source.path);
  if (hash(await readFile(local + 'control-source/' + source.path)) !== source.sha256) throw new Error('Frozen source changed: ' + source.path);
}
for (const input of freeze.privateInputs) if (hash(await readFile(input.path)) !== input.sha256) throw new Error('Private input changed: ' + input.path);
const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom' });
try {
  const { datasetSchema, evaluate } = await server.ssrLoadModule('/' + local + 'control-source/tools/receipt-regression/model.ts');
  const dataset = datasetSchema.parse(await read(datasetFolder + 'dataset.json'));
  const labels = ['control-cold', 'paddle-960-cold', 'paddle-1920'];
  const reports = await Promise.all(labels.map(async label => ({ label, report: await read(local + label + '.json') })));
  const counts = checks => ({ pass: 0, fail: 0, unknown: 0, ...checks.reduce((a,c) => (a[c.status] = (a[c.status] ?? 0) + 1, a), {}) });
  const norm = text => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const median = numbers => [...numbers].sort((a,b) => a-b)[Math.floor(numbers.length/2)];
  const summaries = [];
  for (const { label, report } of reports) {
    if (!report.complete || report.results.length !== 4) throw new Error('Incomplete actual report: ' + label);
    if (report.blockedRequests.length) throw new Error('Unexpected network request: ' + label);
    if (report.runtime.userAgent !== reports[0].report.runtime.userAgent) throw new Error('Different browser runtime');
    const rows = report.results.map(row => {
      if (row.error) throw new Error('Runtime error: ' + label + '/' + row.id);
      const entry = dataset.receipts.find(e => e.id === row.id);
      const input = freeze.privateInputs.find(i => i.path.replace(/\\/g,'/').endsWith('/' + entry.image));
      if (row.inputSha256 !== input.sha256) throw new Error('Different image: ' + row.id);
      const checks = evaluate(entry.expected, row.parsed.receipt);
      if (JSON.stringify(checks) !== JSON.stringify(row.checks)) throw new Error('Recorded checks differ from frozen evaluator');
      const control = reports[0].report.results.find(r => r.id === row.id);
      const items = row.parsed.receipt.items;
      return { id: row.id, ...counts(checks), durationMs: row.durationMs, recognitionMs: row.recognitionMs, adapterMs: row.adapterMs ?? 0,
        exactParsedNames: entry.expected.items.filter(e => items.some(i => norm(i.description) === norm(e.description))).length,
        expectedProducts: entry.expected.items.length, parsedRows: items.length, knownAmounts: items.filter(i => i.lineTotalCents !== null).length,
        flaggedItems: items.filter(i => i.flagged).length, uncertainFields: row.parsed.receipt.uncertainFields,
        fields: checks.filter(c => !c.key.startsWith('item:') && !c.key.startsWith('extra:')),
        items, adapterDiagnostics: row.adapted?.diagnostics ?? [],
        printedTotalCents: row.parsed.receipt.receiptTotalCents,
        calculatedTotalCents: row.totals?.ok ? row.totals.value.totalCents : null,
        changedChecks: label === 'control-cold' ? [] : checks.filter(c => c.status !== control.checks.find(b => b.key === c.key)?.status),
        requiredReview: { parserWarnings: row.parsed.warnings, adapterDiagnostics: row.adapted?.diagnostics ?? [],
          caveat: 'Fewer parser flags are not proof of fewer necessary corrections. Evaluation failures and raw-box associations must be reviewed independently.' },
      };
    });
    const assetNetwork = report.network.filter(r => /\/(?:engine-assets|ort-assets)\//.test(r.url));
    const initialAssetNetwork = assetNetwork.filter(r => label.startsWith('control') ? r.phase.endsWith('Receipt5') : r.phase === 'paddle-initialization');
    const unique = new Map(initialAssetNetwork.map(r => [r.url, r]));
    // CDP reports data: WASM resources too. They are embedded in already-delivered
    // JavaScript, so counting them again would inflate download size.
    const moduleNetwork = report.network.filter(r => r.url.startsWith('http://127.0.0.1:8082/') && !/\/(?:engine-assets|ort-assets)\//.test(r.url) && (label.startsWith('control') ? r.phase.endsWith('Receipt5') : r.phase === 'paddle-initialization'));
    summaries.push({ label, runtime: report.runtime, rows, initialization: report.initialization ?? null,
      scanTotalMs: rows.reduce((n,r) => n+r.durationMs,0), subsequentMedianMs: median(rows.slice(1).map(r => r.durationMs)),
      loading: { engineAssets: [...unique.values()], engineAssetEncodedBytes: [...unique.values()].reduce((n,r) => n+r.encodedBytes,0), moduleEncodedBytes: moduleNetwork.reduce((n,r) => n+r.encodedBytes,0),
        caveat: 'Bytes delivered by the local development server, including HTTP overhead; not a compressed production bundle or WAN latency benchmark. Tesseract core JS embeds WASM; do not double-count the unused separate WASM file.' },
      blockedRequests: report.blockedRequests,
      // Runtime.enable replays prior-page console history before navigation. ORT
      // also writes nonfatal [W:] model-cleanup notices to console.error.
      runtimeErrors: report.console.filter(c => c.phase !== 'page' && ['error','exception','instrumentation'].includes(c.type) && !c.text.includes('[W:onnxruntime:')),
      nonfatalRuntimeWarnings: report.console.filter(c => c.phase !== 'page' && (c.type === 'warning' || c.text.includes('[W:onnxruntime:'))),
    });
  }
  const baseline = await read(local + 'recorded-baseline.json');
  const summary = { kind: 'Private post-extraction evaluation only; no reference inputs to either recogniser or adapter', createdAt: new Date().toISOString(), sourceIntegrity: 'All 118 original working-source files, frozen copies, baseline, references and photos unchanged', baseline: { runtime: baseline.userAgent, results: baseline.results.map(r => ({ id: r.id, ...counts(r.checks) })) },
    fixedParser: 'Frozen src/lib/parser.ts, shared by both engines; no parser/production application edits', reports: summaries,
    decision: 'Insufficient consistent end-to-end benefit with the fixed parser. Keep default Tesseract unchanged; reject higher-resolution variant. Recognition potential warrants generic compatibility work and unseen merchants only before any replacement recommendation.' };
  await writeFile(local + 'comparison.local.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summaries.map(({ label, rows, initialization, scanTotalMs, subsequentMedianMs, loading, runtimeErrors }) => ({ label, initializationMs: initialization?.durationMs, scanTotalMs, subsequentMedianMs, initialAssetBytes: loading.engineAssetEncodedBytes, initialModuleBytes: loading.moduleEncodedBytes, runtimeErrors: runtimeErrors.length, rows: rows.map(({id,pass,fail,exactParsedNames,expectedProducts,parsedRows,knownAmounts,flaggedItems,uncertainFields,printedTotalCents,calculatedTotalCents}) => ({id,pass,fail,exactParsedNames,expectedProducts,parsedRows,knownAmounts,flaggedItems,uncertainFields,printedTotalCents,calculatedTotalCents})) })), null, 2));
} finally { await server.close(); }
