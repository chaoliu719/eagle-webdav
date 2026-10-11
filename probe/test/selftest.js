// 运行：node test/selftest.js
const http = require('http');
const assert = require('assert');
const path = require('path');
require('../plugin/js/davcapture.js');
require('../plugin/js/probes.js');
const EW = globalThis.EW;
const { createMock } = require('./mock-eagle.js');

function req(port, method, p, { headers = {}, body, user } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (user) h.Authorization = 'Basic ' + Buffer.from(user).toString('base64');
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); if (body !== undefined) r.write(body); r.end();
  });
}

(async () => {
  const port = 41699;
  const srv = EW.createCaptureServer({ host: '127.0.0.1', port, user: 'u', pass: 'p' });
  await srv.start();
  const A = { user: 'u:p' };
  let r;
  r = await req(port, 'OPTIONS', '/', {}); assert.strictEqual(r.status, 401);
  r = await req(port, 'OPTIONS', '/', A); assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.dav, '1, 2');
  r = await req(port, 'PROPFIND', '/', A); assert.strictEqual(r.status, 403, 'missing Depth');
  r = await req(port, 'PROPFIND', '/', { ...A, headers: { Depth: '1' } });
  assert.strictEqual(r.status, 207); assert(r.body.includes('/%E7%A4%BA%E4%BE%8B/')); assert(r.body.includes('readme.txt'));
  r = await req(port, 'PROPFIND', '/readme.txt', { ...A, headers: { Depth: '0' }, body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:X="urn:x"><D:prop><D:getcontentlength/><X:foo/></D:prop></D:propfind>' });
  assert(r.body.includes('<D:getcontentlength>') && r.body.includes('404 Not Found') && r.body.includes('urn:x'));
  r = await req(port, 'PROPFIND', '/', { ...A, headers: { Depth: '0' }, body: '<!DOCTYPE x [<!ENTITY a "b">]><propfind xmlns="DAV:"><allprop/></propfind>' });
  assert.strictEqual(r.status, 400);
  r = await req(port, 'PUT', '/no/parent.txt', { ...A, body: 'x' }); assert.strictEqual(r.status, 409);
  r = await req(port, 'PUT', '/a.txt', { ...A, body: 'hello' }); assert.strictEqual(r.status, 201);
  r = await req(port, 'PUT', '/a.txt', { ...A, body: 'hello2' }); assert.strictEqual(r.status, 204);
  r = await req(port, 'GET', '/a.txt', A); assert.strictEqual(r.body, 'hello2');
  r = await req(port, 'GET', '/a.txt', { ...A, headers: { Range: 'bytes=1-3' } }); assert.strictEqual(r.status, 206); assert.strictEqual(r.body, 'ell');
  r = await req(port, 'MKCOL', '/d', A); assert.strictEqual(r.status, 201);
  r = await req(port, 'MKCOL', '/d', A); assert.strictEqual(r.status, 405);
  r = await req(port, 'MKCOL', '/x/y', A); assert.strictEqual(r.status, 409);
  r = await req(port, 'COPY', '/a.txt', { ...A, headers: { Destination: `http://127.0.0.1:${port}/d/b.txt` } }); assert.strictEqual(r.status, 201);
  r = await req(port, 'COPY', '/a.txt', { ...A, headers: { Destination: '/d/b.txt', Overwrite: 'F' } }); assert.strictEqual(r.status, 412);
  r = await req(port, 'MOVE', '/d/b.txt', { ...A, headers: { Destination: '/d/c%20%E4%B8%AD.txt' } }); assert.strictEqual(r.status, 201);
  r = await req(port, 'GET', '/d/c%20%E4%B8%AD.txt', A); assert.strictEqual(r.body, 'hello2');
  r = await req(port, 'MOVE', '/a.txt', { ...A, headers: { Destination: '/a.txt' } }); assert.strictEqual(r.status, 403);
  r = await req(port, 'MOVE', '/a.txt', { ...A, headers: { Destination: 'http://other:1/z.txt' } }); assert.strictEqual(r.status, 502);
  r = await req(port, 'LOCK', '/lockme.txt', { ...A, headers: { Timeout: 'Second-9999' }, body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>me</D:owner></D:lockinfo>' });
  assert.strictEqual(r.status, 201); const tok = r.headers['lock-token']; assert(/^<opaquelocktoken:/.test(tok)); assert(r.body.includes('Second-3600'));
  r = await req(port, 'LOCK', '/lockme.txt', { ...A, headers: { If: `(${tok})` } }); assert.strictEqual(r.status, 200);
  r = await req(port, 'UNLOCK', '/lockme.txt', { ...A, headers: { 'Lock-Token': tok } }); assert.strictEqual(r.status, 204);
  r = await req(port, 'UNLOCK', '/lockme.txt', { ...A, headers: { 'Lock-Token': tok } }); assert.strictEqual(r.status, 409);
  r = await req(port, 'PROPPATCH', '/a.txt', { ...A, body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:z"><D:set><D:prop><Z:Win32FileAttributes>20</Z:Win32FileAttributes></D:prop></D:set></D:propertyupdate>' });
  assert.strictEqual(r.status, 207); assert(r.body.includes('Win32FileAttributes') && r.body.includes('200 OK'));
  r = await req(port, 'DELETE', '/d', A); assert.strictEqual(r.status, 204);
  r = await req(port, 'GET', '/d/c%20%E4%B8%AD.txt', A); assert.strictEqual(r.status, 404);
  r = await req(port, 'GET', '/%2e%2e/x', A); assert.strictEqual(r.status, 400);
  // Expect: 100-continue
  r = await new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/e.txt', headers: { Expect: '100-continue', 'Content-Length': 3, Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    rq.on('continue', () => rq.end('abc')); rq.on('error', reject); rq.flushHeaders();
  });
  assert.strictEqual(r.status, 201);
  assert(srv.ring().length > 20);
  await srv.stop();
  console.log('capture server OK, requests logged:', srv.ring().length);

  // 探针对 mock
  const { eagle } = createMock();
  const env = await EW.collectEnv(eagle);
  assert.strictEqual(env.itemCountAll, 0);
  const rep = await EW.runWriteProbes(eagle, { log: () => {}, bigMB: 1, bookmark: true });
  const failed = rep.steps.filter((s) => !s.ok);
  console.log('write probe steps:', rep.steps.length, 'failed:', failed.map((f) => f.name));
  console.log('verdicts:', JSON.stringify(rep.verdicts));
  assert.strictEqual(failed.length, 0);
  assert.strictEqual(rep.verdicts.R3_folders可写, true);
  const perf = await EW.runPerfProbe(eagle, { log: () => {} });
  assert(perf.timings.length >= 4);
  console.log('perf probe OK');

  // 假 DOM 加载 plugin.js
  const els = {};
  const mkEl = (id) => (els[id] = { id, value: '', checked: false, disabled: false, textContent: '', style: {}, select() {} });
  ['status', 'btnEnv', 'host', 'port', 'user', 'pass', 'btnStart', 'btnStop', 'urls', 'reqlog', 'ack', 'bigmb', 'bookmark', 'dup', 'btnWrite', 'btnPerf', 'btnExport', 'btnCopy', 'reportPath', 'reportBox', 'log'].forEach(mkEl);
  globalThis.document = { readyState: 'complete', getElementById: (i) => els[i], addEventListener() {}, execCommand() {}, visibilityState: 'visible' };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.eagle = eagle;
  require('../plugin/js/plugin.js');
  els.port.value = '41698'; els.host.value = '127.0.0.1';
  await els.btnStart.onclick();
  assert(els.btnStop.disabled === false, 'server started via UI');
  await els.btnStop.onclick();
  els.ack.checked = true; els.ack.onchange(); assert.strictEqual(els.btnWrite.disabled, false);
  await els.btnEnv.onclick(); await new Promise((r) => setTimeout(r, 200));
  els.btnExport.onclick();
  assert(els.reportBox.value.includes('"tool": "eagle-webdav-probe"'));
  console.log('plugin.js UI wiring OK; log:', els.reportPath.textContent);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
