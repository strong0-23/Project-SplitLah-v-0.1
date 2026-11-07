import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { connect } from './cdp.mjs';
const local = 'receipt-regression.local/engine-comparison/';
const datasetFolder = process.argv[2] ?? 'receipt-regression.local/first-four/';
const mode = process.argv[3] ?? 'control';
const cold = process.argv[4] === '--cold';
const label = mode + (cold ? '-cold' : '');
if (!['control', 'paddle-960', 'paddle-1920', 'paddle-warm'].includes(mode)) throw new Error('Unknown bounded experiment mode');
const freeze = JSON.parse(await readFile(local + 'control-freeze.json', 'utf8'));
for (const source of freeze.sources) {
  const bytes = await readFile(local + 'control-source/' + source.path);
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('Frozen source changed: ' + source.path);
}
for (const input of freeze.privateInputs) if (createHash('sha256').update(await readFile(input.path)).digest('hex') !== input.sha256) throw new Error('Private input changed: ' + input.path);
const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: 'custom' });
const browser = await connect(9333, cold);
const report = { kind: 'Actual original-photo browser OCR, fixed frozen parser; not saved-text replay', mode, cold, label, startedAt: new Date().toISOString(), complete: false, runtime: await browser.evaluate('window.sandbox.runtime()'), browserVersion: await browser.send('Browser.getVersion'), results: [] };
report.sandboxSourceHashes = Object.fromEntries(await Promise.all(['browser.ts','adapter.ts','cdp.mjs','vite.config.ts','package.json','package-lock.json'].map(async name => [name, createHash('sha256').update(await readFile('tools/ocr-engine-sandbox/' + name)).digest('hex')])));
report.frozenParserSha256 = freeze.sources.find(source => source.path === 'src/lib/parser.ts').sha256;
try {
  const { datasetSchema, evaluate } = await server.ssrLoadModule('/tools/receipt-regression/model.ts');
  const dataset = datasetSchema.parse(JSON.parse(await readFile(datasetFolder + 'dataset.json', 'utf8')));
  if (dataset.receipts.length !== 4) throw new Error('Bounded experiment expects the same four-receipt dataset');
  if (mode !== 'control') {
    browser.setPhase('paddle-initialization');
    try { report.initialization = await browser.evaluate('window.sandbox.initializePaddle()'); }
    catch (e) { report.initializationError = String(e); throw e; }
  }
  for (const entry of dataset.receipts) {
    browser.setPhase(`${mode}:${entry.id}`);
    const bytes = await readFile(datasetFolder + entry.image);
    const args = [bytes.toString('base64'), entry.image, mode === 'control' ? entry.scanOptions : mode === 'paddle-960' ? 960 : 1920];
    const result = await browser.evaluate(`window.sandbox.${mode === 'control' ? 'tesseract' : 'predictPaddle'}(${args.map(a => JSON.stringify(a)).join(',')})`);
    result.id = entry.id; result.inputSha256 = createHash('sha256').update(bytes).digest('hex');
    result.checks = evaluate(entry.expected, result.parsed?.receipt ?? null);
    report.results.push(result);
    console.log(JSON.stringify({ mode, id: entry.id, durationMs: Math.round(result.durationMs), error: result.error, rows: result.parsed?.receipt.items.length, knownAmounts: result.parsed?.receipt.items.filter(i => i.lineTotalCents !== null).length, checks: result.checks.reduce((a,c)=>(a[c.status]=(a[c.status]??0)+1,a),{}) }));
    await save();
  }
  report.complete = true;
} finally { await save(); browser.close(); await server.close(); }
async function save() {
  report.network = browser.network; report.assetDeliveries = browser.deliveries; report.blockedRequests = browser.blocked; report.console = browser.consoleMessages;
  await writeFile(local + label + '.json', JSON.stringify(report, null, 2));
}
