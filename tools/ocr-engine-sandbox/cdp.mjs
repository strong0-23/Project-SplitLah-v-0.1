import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
export async function connect(port = 9333, cold = false) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8082')) ?? targets.find(t => t.type === 'page' && t.url === 'about:blank');
  if (!target) throw new Error('No page in the dedicated comparison browser');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  const requests = new Map();
  const network = [];
  const consoleMessages = [];
  const blocked = [];
  const deliveries = [];
  let phase = 'page';
  const manifest = JSON.parse(await readFile('receipt-regression.local/engine-comparison/assets/manifest.json', 'utf8'));
  const pinned = new Map(await Promise.all(manifest.assets.map(async a => [a.url, { ...a, body: (await readFile('receipt-regression.local/engine-comparison/assets/' + a.name)).toString('base64') }])));
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  async function instrumentation(sessionId) {
    await send('Network.enable', {}, sessionId);
    if (!sessionId) await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await send('Runtime.enable', {}, sessionId);
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
  }
  socket.addEventListener('message', async event => {
    const reply = JSON.parse(event.data);
    if (reply.id) {
      const call = pending.get(reply.id);
      if (call) { pending.delete(reply.id); reply.error ? call.reject(new Error(JSON.stringify(reply.error))) : call.resolve(reply.result); }
      return;
    }
    const { method, params: p, sessionId } = reply;
    try {
      if (method === 'Target.attachedToTarget') {
        await instrumentation(p.sessionId);
        // Worker targets lack the Fetch domain. Redirect only pinned engine asset
        // URLs at the transport boundary; frozen application code stays unchanged.
        const routes = Object.fromEntries(manifest.assets.map(a => [a.url, 'http://127.0.0.1:8082/engine-assets/' + a.name]));
        const expression = `(()=>{const routes=${JSON.stringify(routes)};const local='http://127.0.0.1:8082/';const map=url=>{const value=String(url);if(routes[value])return routes[value];if(value.startsWith(local)||value.startsWith('blob:')||value.startsWith('data:'))return value;throw new Error('Sandbox blocked external worker asset: '+value)};const originalFetch=self.fetch.bind(self);self.fetch=(input,options)=>{if((options?.method??'GET').toUpperCase()!=='GET')throw new Error('Sandbox blocks worker uploads');return originalFetch(map(typeof input==='string'?input:input.url),options)};if(self.importScripts){const original=self.importScripts.bind(self);self.importScripts=(...urls)=>original(...urls.map(map));}})()`;
        await send('Runtime.evaluate', { expression }, p.sessionId);
        await send('Runtime.runIfWaitingForDebugger', {}, p.sessionId);
      } else if (method === 'Fetch.requestPaused') {
        const asset = pinned.get(p.request.url);
        if (asset && p.request.method === 'GET') {
          deliveries.push({ phase, url: p.request.url, bytes: asset.bytes, sha256: asset.sha256, source: 'pinned local asset substituted without modifying control code' });
          const type = asset.name.endsWith('.js') ? 'text/javascript' : asset.name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
          await send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: asset.body }, sessionId);
        } else if (/^(?:http:\/\/127\.0\.0\.1:8082\/|blob:|data:)/.test(p.request.url) && ['GET','HEAD'].includes(p.request.method)) {
          await send('Fetch.continueRequest', { requestId: p.requestId }, sessionId);
        } else {
          blocked.push({ phase, url: p.request.url, method: p.request.method });
          await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sessionId);
        }
      } else if (method === 'Network.requestWillBeSent') {
        const row = { phase, url: p.request.url.startsWith('data:') ? p.request.url.slice(0, p.request.url.indexOf(',') + 1) + '[inline payload omitted]' : p.request.url, method: p.request.method, resourceType: p.type, encodedBytes: 0 };
        requests.set(`${sessionId ?? ''}:${p.requestId}`, row); network.push(row);
      } else if (method === 'Network.loadingFinished') {
        const row = requests.get(`${sessionId ?? ''}:${p.requestId}`); if (row) row.encodedBytes = p.encodedDataLength;
      } else if (method === 'Runtime.consoleAPICalled') {
        consoleMessages.push({ phase, type: p.type, text: p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 2000) });
      } else if (method === 'Runtime.exceptionThrown') {
        consoleMessages.push({ phase, type: 'exception', text: p.exceptionDetails.exception?.description ?? p.exceptionDetails.text });
      }
    } catch (e) { consoleMessages.push({ phase, type: 'instrumentation', text: String(e) }); }
  });
  await instrumentation(); await send('Page.enable');
  if (cold) {
    await send('Network.clearBrowserCache');
    await send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8082', storageTypes: 'all' });
  }
  const evaluate = async expression => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 180000 });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result.value;
  };
  await send('Page.navigate', { url: 'http://127.0.0.1:8082/' });
  for (let n = 0; n < 100; n++) {
    if (await evaluate('!!window.sandbox')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!await evaluate('!!window.sandbox')) { socket.close(); throw new Error('Sandbox module did not load: ' + JSON.stringify({ consoleMessages, blocked })); }
  return { evaluate, send, network, consoleMessages, blocked, deliveries, setPhase: value => { phase = value; }, close: () => socket.close() };
}
