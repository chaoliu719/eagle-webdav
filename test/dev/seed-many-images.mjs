// 往真实 Eagle 资源库灌大量小图片（经运行中的插件的 WebDAV 接口），用来测大目录性能。幂等：已有的跳过，可续传。
// 用法：node test/dev/seed-many-images.mjs [数量=5000] [端口=41600] [密码]
// 放在 /__e2e__/海量图片/ 下；每张 png 的颜色都不同（内容唯一，不会触发 Eagle 的重复添加提示）。
import { deflateSync } from 'zlib';

const total = Number(process.argv[2] || 5000);
const port = process.argv[3] || '41600';
const pass = process.argv[4];
const base = `http://127.0.0.1:${port}`;
const auth = pass ? { Authorization: 'Basic ' + Buffer.from(`eagle:${pass}`).toString('base64') } : {};
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const DIR = '/__e2e__/海量图片';
const CONCURRENCY = 4;

const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(rgb) {
  const w = 32, h = 32;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// 连接被掐断（Eagle 忙或插件重启）时退避重试，最多等约一分钟
async function call(method, p, body) {
  for (let n = 0; ; n++) {
    try { return await fetch(base + enc(p), { method, headers: auth, body }); }
    catch (e) { if (n >= 12) throw e; await new Promise((r) => setTimeout(r, 1000 * Math.min(n + 1, 5))); }
  }
}

for (const p of ['/__e2e__', DIR]) {
  const r = await call('MKCOL', p);
  if (r.status !== 201 && r.status !== 405) throw new Error(`MKCOL ${p} → ${r.status}`);
}
const listing = await (await fetch(base + enc(DIR) + '/', { method: 'PROPFIND', headers: { ...auth, Depth: '1' } })).text();
const have = new Set([...listing.matchAll(/<D:displayname>([^<]*)</g)].map((m) => m[1]));
const todo = [];
for (let i = 1; i <= total; i++) { const n = `img-${String(i).padStart(5, '0')}.png`; if (!have.has(n)) todo.push([i, n]); }
console.log(`目标 ${total} 张，已有 ${total - todo.length}，待写入 ${todo.length}`);

let done = 0, failed = 0;
const t0 = Date.now();
async function worker() {
  for (let job; (job = todo.shift()); ) {
    const [i, name] = job;
    // 颜色由序号唯一决定（24 位，足够 1600 万张）
    const r = await call('PUT', `${DIR}/${name}`, png([(i >> 16) & 255, (i >> 8) & 255, i & 255]));
    if (r.status !== 201) { failed++; console.log('失败', name, r.status); }
    if (++done % 250 === 0) console.log(`${done} 张，${Math.round(done / ((Date.now() - t0) / 1000))} 张/秒`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`完成：新写入 ${done - failed}，失败 ${failed}，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
