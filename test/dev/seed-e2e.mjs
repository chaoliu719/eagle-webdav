// 往真实 Eagle 资源库预置 e2e 测试数据（经由运行中的插件的 WebDAV 接口写入，幂等，可重复运行）。
// 用法：node test/dev/seed-e2e.mjs [端口=41600] [密码，留空表示不认证]
// 全部内容放在顶层文件夹 __e2e__ 下，另有一个 @未分类 条目；每个文件内容都不同，避免触发 Eagle 的重复添加提示。
import { createHash, randomBytes } from 'crypto';
import { deflateSync } from 'zlib';

const port = process.argv[2] || '41600';
const pass = process.argv[3];
const base = `http://127.0.0.1:${port}`;
const auth = pass ? { Authorization: 'Basic ' + Buffer.from(`eagle:${pass}`).toString('base64') } : {};
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const R = '/__e2e__';

function png(w, h, rgb) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function req(method, p, { headers = {}, body } = {}) {
  const r = await fetch(base + enc(p), { method, headers: { ...auth, ...headers }, body });
  return { status: r.status, text: await r.text() };
}
const exists = async (p) => (await req('HEAD', p)).status === 200 || (await req('PROPFIND', p, { headers: { Depth: '0' } })).status === 207;

const manifest = [];
async function mkdirs(p) {
  const segs = p.split('/').filter(Boolean);
  for (let i = 1; i <= segs.length; i++) {
    const cur = '/' + segs.slice(0, i).join('/');
    if (await exists(cur)) continue;
    const r = await req('MKCOL', cur);
    if (r.status !== 201) throw new Error(`MKCOL ${cur} → ${r.status}`);
    console.log('MKCOL', cur);
  }
}
async function put(p, body) {
  if (await exists(p)) { console.log('已有  ', p); manifest.push(p); return; }
  await mkdirs(p.slice(0, p.lastIndexOf('/')));
  const r = await req('PUT', p, { body });
  if (r.status !== 201) throw new Error(`PUT ${p} → ${r.status} ${r.text}`);
  console.log('PUT   ', p);
  manifest.push(p);
}
const patch = async (p, inner) => {
  const r = await req('PROPPATCH', p, { headers: { 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:E="urn:eagle-webdav:ns"><D:set><D:prop>${inner}</D:prop></D:set></D:propertyupdate>` });
  if (r.status !== 207 || !r.text.includes('200 OK')) throw new Error(`PROPPATCH ${p} → ${r.status}`);
  console.log('PATCH ', p);
};

// 图片：不同颜色、不同尺寸
await put(`${R}/图片/red.png`, png(16, 16, [220, 40, 40]));
await put(`${R}/图片/green.png`, png(24, 24, [40, 200, 60]));
await put(`${R}/图片/blue.png`, png(32, 20, [40, 70, 220]));
await put(`${R}/图片/矢量.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="16" fill="#e91e63"/></svg>');

// 文档：中文名、空格与特殊字符、Markdown
await put(`${R}/文档/readme.txt`, 'eagle webdav e2e fixture\n');
await put(`${R}/文档/说明 文档.md`, '# 中文 Markdown\n\n预置条目，用于 e2e 测试。\n');
await put(`${R}/文档/a b #c&d (1).txt`, 'special chars in name\n');
await put(`${R}/文档/accent-café.txt`, 'café\n');

// 嵌套文件夹
await put(`${R}/嵌套/一级/二级/deep.txt`, 'deep\n');
await put(`${R}/嵌套/一级/level1.txt`, 'level 1\n');

// 大文件：6 MB 随机内容，用来测 Range / 断点；校验和写入清单
await put(`${R}/大文件/random-6mb.bin`, randomBytes(6 * 1024 * 1024));
const big = Buffer.from(await (await fetch(base + enc(`${R}/大文件/random-6mb.bin`), { headers: auth })).arrayBuffer());

// 元数据：标签 / 星级 / 注释 / 来源链接
const metaPath = `${R}/元数据/tagged.txt`;
await put(metaPath, 'item with metadata\n');
await patch(metaPath, '<E:tags>["e2e","测试"]</E:tags><E:star>3</E:star><E:annotation>预置的注释</E:annotation><E:url>https://example.com/e2e</E:url>');
await put(`${R}/元数据/tagged2.txt`, 'second tagged item\n');
await patch(`${R}/元数据/tagged2.txt`, '<E:tags>["e2e"]</E:tags>');

// 多归属：同名 COPY 到另一个文件夹 = 同一个条目属于两个文件夹
const shared = `${R}/多归属/甲/shared.txt`;
await put(shared, 'one item, two folders\n');
await mkdirs(`${R}/多归属/乙`);
if (!(await exists(`${R}/多归属/乙/shared.txt`))) {
  const r = await req('COPY', shared, { headers: { Destination: base + enc(`${R}/多归属/乙/shared.txt`) } });
  if (r.status !== 201) throw new Error(`COPY shared → ${r.status}`);
  console.log('COPY  ', `${R}/多归属/乙/shared.txt`);
}

// 未分类
await put(`/@未分类/__e2e__-unfiled.txt`, 'unfiled e2e item\n');

console.log('\n--- 清单 ---');
console.log(JSON.stringify({ root: R, items: manifest, bigSha256: createHash('sha256').update(big).digest('hex') }, null, 2));
