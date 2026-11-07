import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const out = path.resolve('receipt-regression.local/engine-comparison/assets');
await mkdir(out, { recursive: true });
const assets = [
  ['PP-OCRv5_mobile_det.tar', 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar'],
  ['PP-OCRv5_mobile_rec.tar', 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar'],
  ['tesseract-worker-5.1.1.js', 'https://cdn.jsdelivr.net/npm/tesseract.js@v5.1.1/dist/worker.min.js'],
  ['tesseract-core-simd-lstm-5.1.1.wasm.js', 'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.1.1/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract-core-simd-lstm-5.1.1.wasm', 'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.1.1/tesseract-core-simd-lstm.wasm'],
  ['eng-4.0.0_best_int.traineddata.gz', 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'],
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestPath = path.join(out, 'manifest.json');
let existing;
try { existing = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
const records = await Promise.all(assets.map(async ([name, url]) => {
  const destination = path.join(out, name);
  const pinned = existing?.assets.find(a => a.name === name);
  if (pinned) {
    const bytes = await readFile(destination);
    if (hash(bytes) !== pinned.sha256) throw new Error('Pinned asset changed: ' + name);
    return pinned;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`Asset download ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
  return { name, url, bytes: (await stat(destination)).size, sha256: hash(bytes), downloadedAt: new Date().toISOString(), etag: response.headers.get('etag'), contentType: response.headers.get('content-type') };
}));
await writeFile(manifestPath, JSON.stringify({ kind: 'Public official engine/model assets only; pinned by exact local bytes', assets: records }, null, 2));
console.log(JSON.stringify(records.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })), null, 2));
