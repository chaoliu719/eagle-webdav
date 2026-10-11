// 真实 Eagle 上的写入冒烟测试：只在 __webdav_test_ 开头的文件夹里操作，结束后条目进回收站。
// 用法：node test/dev/real-write-smoke.mjs <端口> [密码]
import { deflateSync } from 'zlib';

const port = process.argv[2] || '41610';
const pass = process.argv[3] || 'test';
const base = `http://127.0.0.1:${port}`;
const auth = 'Basic ' + Buffer.from(`eagle:${pass}`).toString('base64');
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const T = '/__webdav_test_M3_' + Date.now().toString(36);

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
  const r = await fetch(base + enc(p), { method, headers: { Authorization: auth, ...headers }, body });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, buf, text: buf.toString('utf8') };
}
const dest = (p) => ({ Destination: base + enc(p) });
const hrefs = (xml) => [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => decodeURIComponent(m[1])).slice(1);
const ls = async (p) => hrefs((await req('PROPFIND', p, { headers: { Depth: '1' } })).text);

let fails = 0;
const check = (label, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!ok) fails++; };
const ms = async (fn) => { const t = Date.now(); const r = await fn(); r.ms = Date.now() - t; return r; };

const p1 = png(16, 16, [200, 30, 30]);
const p2 = png(24, 24, [30, 200, 30]);
const p3 = png(20, 20, [30, 30, 200]);
const created = [];

let r = await req('MKCOL', T); check('MKCOL 顶层测试文件夹', r.status === 201, String(r.status));
r = await req('MKCOL', T + '/sub'); check('MKCOL 子文件夹', r.status === 201, String(r.status));
r = await req('MKCOL', T); check('MKCOL 已存在 405', r.status === 405);

r = await ms(() => req('PUT', T + '/a.png', { body: p1 })); check('PUT 新建 png', r.status === 201, `${r.status} ${r.ms}ms`);
check('列表出现 a.png', (await ls(T)).includes(T + '/a.png'));
r = await req('GET', T + '/a.png'); check('GET 内容一致', r.buf.equals(p1));
const etag1 = r.headers.get('etag');

r = await ms(() => req('PUT', T + '/a.png', { body: p2 })); check('PUT 覆盖（replaceFile）', r.status === 204, `${r.status} ${r.ms}ms`);
r = await req('GET', T + '/a.png'); check('覆盖后内容更新', r.buf.equals(p2), `etag ${etag1} → ${r.headers.get('etag')}`);
check('覆盖后 ETag 变化', r.headers.get('etag') !== etag1);

r = await ms(() => req('PUT', T + '/noext', { body: 'x' })); check('无扩展名 415（不触发 Eagle）', r.status === 415, `${r.status} ${r.ms}ms`);
r = await req('PUT', T + '/note.txt', { body: 'hello eagle' }); check('PUT txt', r.status === 201, String(r.status));

// Finder 写入序列
r = await req('PUT', T + '/f.png', { body: '' }); check('0 字节占位 201', r.status === 201);
r = await req('LOCK', T + '/f.png', { headers: { Depth: '0', Timeout: 'Second-600' }, body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>' });
const token = /<opaquelocktoken:([^>]+)>/.exec(r.headers.get('lock-token') || '')?.[1];
check('LOCK', r.status === 200 && !!token);
r = await ms(() => req('PUT', T + '/f.png', { headers: { If: `(<opaquelocktoken:${token}>)` }, body: p1 })); check('带内容 PUT 导入', r.status === 201, `${r.status} ${r.ms}ms`);
r = await req('UNLOCK', T + '/f.png', { headers: { 'Lock-Token': `<opaquelocktoken:${token}>` } }); check('UNLOCK', r.status === 204);
check('f.png 只出现一次', (await ls(T)).filter((x) => x === T + '/f.png').length === 1);

// 系统文件
r = await req('PUT', T + '/.DS_Store', { body: 'junk' }); check('.DS_Store 影子', r.status === 201);
r = await req('PUT', T + '/._a.png', { body: 'apple' }); check('._a.png 影子', r.status === 201);
check('系统文件不在列表', !(await ls(T)).some((x) => x.includes('.DS_Store') || x.includes('._')));

// MOVE 改名（真实重命名磁盘文件）
r = await req('MOVE', T + '/a.png', { headers: dest(T + '/b.png') }); check('MOVE 改名', r.status === 201, String(r.status));
r = await req('GET', T + '/b.png'); check('改名后 GET 用最新 filePath', r.status === 200 && r.buf.equals(p2));
r = await req('GET', T + '/a.png'); check('旧名 404', r.status === 404);
r = await req('MOVE', T + '/b.png', { headers: dest(T + '/b.jpg') }); check('改扩展名 403', r.status === 403);
r = await req('MOVE', T + '/b.png', { headers: dest(T + '/sub/b.png') }); check('MOVE 跨目录', r.status === 201, String(r.status));
check('sub 里出现 b.png、T 里消失', (await ls(T + '/sub')).includes(T + '/sub/b.png') && !(await ls(T)).includes(T + '/b.png'));

// COPY
r = await req('COPY', T + '/sub/b.png', { headers: dest(T + '/b.png') }); check('COPY 同名跨目录（按引用）', r.status === 201, String(r.status));
check('两处都有 b.png', (await ls(T)).includes(T + '/b.png') && (await ls(T + '/sub')).includes(T + '/sub/b.png'));
// 真复制（COPY 改名）内容相同，Eagle 会弹「重复添加提示」并等人确认，无法自动化，这里改用 PUT 造一个不同内容的 b2
r = await req('PUT', T + '/b2.png', { body: p3 }); check('PUT b2.png（不同内容）', r.status === 201, String(r.status));

// PROPPATCH
const ns = 'urn:eagle-webdav:ns';
r = await req('PROPPATCH', T + '/b2.png', { body: `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:E="${ns}"><D:set><D:prop><E:tags>["webdav-test","m3"]</E:tags><E:star>3</E:star><E:annotation>m3 smoke</E:annotation></D:prop></D:set></D:propertyupdate>` });
check('PROPPATCH', r.status === 207 && r.text.includes('200 OK'), String(r.status));
r = await req('PROPFIND', T + '/b2.png', { headers: { Depth: '0' }, body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:E="${ns}"><D:prop><E:tags/><E:star/><E:annotation/></D:prop></D:propfind>` });
check('PROPFIND 读回 E 属性', r.text.includes('webdav-test') && r.text.includes('>3<') && r.text.includes('m3 smoke'));

// @未分类 往返
r = await req('MOVE', T + '/b2.png', { headers: dest('/@未分类/__webdav_test_b2.png') }); check('MOVE 到 @未分类', r.status === 201, String(r.status));
r = await req('GET', '/@未分类/__webdav_test_b2.png'); check('@未分类 可读', r.status === 200 && r.buf.equals(p3));
r = await req('MOVE', '/@未分类/__webdav_test_b2.png', { headers: dest(T + '/b2.png') }); check('从 @未分类 移回', r.status === 201, String(r.status));

// 文件夹操作
r = await req('MOVE', T + '/sub', { headers: dest(T + '/sub2') }); check('MOVE 文件夹改名', r.status === 201, String(r.status));
r = await req('DELETE', T + '/sub2'); check('DELETE 文件夹 403', r.status === 403);

// DELETE 条目
for (const n of ['b.png', 'b2.png', 'f.png', 'note.txt']) {
  r = await req('DELETE', T + '/' + n); check(`DELETE ${n}`, r.status === 204, String(r.status));
}
r = await req('DELETE', T + '/sub2/b.png'); check('DELETE 多归属条目（一删全删）', r.status === 204 || r.status === 404, String(r.status));
check('测试文件夹已清空条目', (await ls(T)).filter((x) => !x.endsWith('/')).length === 0, JSON.stringify(await ls(T)));

console.log(`\n测试文件夹：${T}（Eagle 无删除文件夹的 API，请手动删除）  失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
