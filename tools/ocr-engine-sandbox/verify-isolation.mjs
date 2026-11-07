import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const local = 'receipt-regression.local/engine-comparison/';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const walk = async dir => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? walk(dir + '/' + entry.name) : [dir + '/' + entry.name]))).flat();
const freeze = JSON.parse(await readFile(local + 'control-freeze.json', 'utf8'));
for (const source of freeze.sources) {
  if (hash(await readFile(source.path)) !== source.sha256 || hash(await readFile(local + 'control-source/' + source.path)) !== source.sha256) throw new Error('Control changed: ' + source.path);
}
for (const input of freeze.privateInputs) if (hash(await readFile(input.path)) !== input.sha256) throw new Error('Private input changed: ' + input.path);
const assetManifest = JSON.parse(await readFile(local + 'assets/manifest.json', 'utf8'));
for (const asset of assetManifest.assets) if (hash(await readFile(local + 'assets/' + asset.name)) !== asset.sha256) throw new Error('Pinned asset changed: ' + asset.name);
const reports = await Promise.all(['control-cold','paddle-960-cold','paddle-1920'].map(async label => JSON.parse(await readFile(local + label + '.json', 'utf8'))));
const privateTexts = reports.flatMap(report => report.results.flatMap(row => [row.ocr?.text, row.adapted?.text, ...(row.ocr?.items ?? []).map(item => item.text)])).filter(text => text?.length > 60);
const privateHashes = new Set(await Promise.all([...freeze.privateInputs.map(i => i.path), ...assetManifest.assets.map(a => local + 'assets/' + a.name)].map(async file => hash(await readFile(file)))));
const built = await walk('.output');
for (const file of built) {
  const bytes = await readFile(file);
  if (privateHashes.has(hash(bytes))) throw new Error('Private/model asset copied into production: ' + file);
  if (/\.(?:m?js|json|html|css|txt)$/.test(file)) {
    const text = bytes.toString('utf8');
    if (/paddleocr|ocr-engine-sandbox|receipt-regression\.local/i.test(text) || privateTexts.some(value => text.includes(value) || text.includes(JSON.stringify(value)))) throw new Error('Sandbox/private content found in production: ' + file);
  }
}
if (execFileSync('git.exe', ['ls-files', 'receipt-regression.local'], { encoding: 'utf8' }).trim()) throw new Error('Private local data is tracked');
for (const report of reports) {
  if (!report.complete || report.blockedRequests.length || report.results.some(r => r.error)) throw new Error('Incomplete or failed quality run');
  if (report.network.some(r => !/^(?:http:\/\/127\.0\.0\.1:8082\/|blob:|data:)/.test(r.url) || !['GET','HEAD'].includes(r.method))) throw new Error('Non-local or upload network request');
}
const status = JSON.parse(await readFile(local + 'comparison.local.json', 'utf8'));
const result = { checkedAt: new Date().toISOString(), unchangedOriginalSourceFiles: freeze.sources.length, preservedPrivateInputs: freeze.privateInputs.length, pinnedAssetHashes: assetManifest.assets.length, productionFilesChecked: built.length, privateDataTracked: false, sandboxInProduction: false, externalRecognitionRequests: 0, runtimeFailures: status.reports.reduce((n,r)=>n+r.runtimeErrors.length,0) };
await writeFile(local + 'isolation-check.local.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
