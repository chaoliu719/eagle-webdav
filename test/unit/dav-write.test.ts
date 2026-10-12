import assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { ConfigStore } from '../../src/config/config';
import { DavRouter } from '../../src/dav/router';
import { FakeEagleAdapter } from '../../src/eagle/fakeAdapter';
import { DavServer } from '../../src/http/server';
import { LibraryIndex } from '../../src/index/libraryIndex';
import { RingLogger } from '../../src/util/log';

// 端口由系统分配，避免与本机其他进程（含残留的测试进程）串线
let PORT = 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewdav-w-'));
const store = new ConfigStore(dir);
store.load();
store.update({ host: '127.0.0.1', port: 0, username: 'u' });
store.setPassword('p');

const fake = new FakeEagleAdapter();
const A = fake.addFolder('A');
const B = fake.addFolder('B');
const A1 = fake.addFolder('A1', A.id);
const logger = new RingLogger();
const index = new LibraryIndex(fake);
const router = new DavRouter(fake, index, logger, { maxPut: 1024 * 1024, tmpRoot: path.join(dir, 'put') });
const server = new DavServer({ getConfig: () => store.get(), logger, handler: (a, b) => router.handle(a, b) });

const AUTH = { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };
const enc = (p: string) => p.split('/').map((x) => encodeURIComponent(x)).join('/');
function req(method: string, p: string, headers: http.OutgoingHttpHeaders = {}, body?: string | Buffer) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: enc(p), headers: { ...AUTH, ...headers } }, (res) => {
      const c: Buffer[] = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(c).toString() }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const dest = (p: string) => ({ Destination: `http://127.0.0.1:${PORT}${enc(p)}` });
const names = async (p: string) => {
  const r = await req('PROPFIND', p, { Depth: '1' });
  return Array.from(r.body.matchAll(/<D:href>([^<]*)<\/D:href>/g)).map((m) => decodeURIComponent(m[1])).slice(1);
};

test('启动', async () => { await server.start(); PORT = server.listenInfo!.port; });

test('PUT 新建 / 覆盖 / 约束', async () => {
  let r = await req('PUT', '/A/hello.txt', {}, 'hello');
  assert.strictEqual(r.status, 201);
  assert.ok((await names('/A')).includes('/A/hello.txt/'.slice(0, -1)));
  assert.strictEqual((await req('GET', '/A/hello.txt')).body, 'hello');
  assert.deepStrictEqual(fake.items.find((i) => i.name === 'hello')?.folders, [A.id]);

  r = await req('PUT', '/A/hello.txt', {}, 'hello world');
  assert.strictEqual(r.status, 204);
  assert.strictEqual((await req('GET', '/A/hello.txt')).body, 'hello world');
  assert.strictEqual(fake.items.filter((i) => i.name === 'hello').length, 1);

  assert.strictEqual((await req('PUT', '/A/hello.md', {}, 'x')).status, 201);
  assert.strictEqual((await req('PUT', '/nope/x.txt', {}, 'x')).status, 409);
  assert.strictEqual((await req('PUT', '/A', {}, 'x')).status, 405);
  assert.strictEqual((await req('PUT', '/root.txt', {}, 'x')).status, 403);
  assert.strictEqual((await req('PUT', '/A/noext', {}, 'x')).status, 415);
  assert.strictEqual((await req('PUT', '/A/big.bin', {}, Buffer.alloc(2 * 1024 * 1024))).status, 413);
  assert.strictEqual((await req('PUT', '/@未分类/loose.txt', {}, 'x')).status, 201);
  assert.deepStrictEqual(fake.items.find((i) => i.name === 'loose')?.folders, []);
});

test('同样大小的内容覆盖后 ETag 与 Last-Modified 也要变化；modifiedAt 为 0 时不出现 1970', async () => {
  const it = fake.addItem('same', 'txt', 'AAAA', [A.id]);
  it.modifiedAt = 0; // 模拟 Eagle：新导入条目 modifiedAt 为 0
  it.importedAt = 1_700_000_000_000;
  index.invalidate();
  let r = await req('GET', '/A/same.txt');
  const etag1 = String(r.headers['etag']);
  assert.ok(!/1970/.test(String(r.headers['last-modified'])), 'Last-Modified 不应是 1970');
  await new Promise((x) => setTimeout(x, 20));
  assert.strictEqual((await req('PUT', '/A/same.txt', {}, 'BBBB')).status, 204);
  r = await req('GET', '/A/same.txt');
  assert.strictEqual(r.body, 'BBBB');
  assert.notStrictEqual(String(r.headers['etag']), etag1);
  const pf = await req('PROPFIND', '/A/same.txt', { Depth: '0' });
  assert.ok(pf.body.includes(String(r.headers['etag']).replace(/"/g, '&quot;')) || pf.body.includes(String(r.headers['etag'])), 'PROPFIND 与 GET 的 ETag 一致');
});

test('Finder 写入序列：0 字节占位 → LOCK → 带内容 PUT → UNLOCK', async () => {
  const before = fake.items.length;
  let r = await req('PUT', '/B/finder.txt', {}, '');
  assert.strictEqual(r.status, 201);
  assert.strictEqual(fake.items.length, before, '占位不入库');
  assert.ok((await names('/B')).includes('/B/finder.txt'), '占位在列表里可见');
  assert.strictEqual((await req('PROPFIND', '/B/finder.txt', { Depth: '0' })).status, 207);

  const lockBody = '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>';
  r = await req('LOCK', '/B/finder.txt', { Depth: '0', Timeout: 'Second-600' }, lockBody);
  assert.strictEqual(r.status, 200);
  const token = /<opaquelocktoken:([^>]+)>/.exec(String(r.headers['lock-token']))![1];
  r = await req('PUT', '/B/finder.txt', { If: `(<opaquelocktoken:${token}>)` }, 'real content');
  assert.strictEqual(r.status, 201);
  assert.strictEqual(fake.items.length, before + 1);
  assert.strictEqual((await req('GET', '/B/finder.txt')).body, 'real content');
  assert.strictEqual((await req('UNLOCK', '/B/finder.txt', { 'Lock-Token': `<opaquelocktoken:${token}>` })).status, 204);
  assert.strictEqual((await names('/B')).filter((n) => n === '/B/finder.txt').length, 1);
});

test('系统文件只进影子暂存区', async () => {
  const before = fake.items.length;
  assert.strictEqual((await req('PUT', '/A/.DS_Store', {}, 'junk')).status, 201);
  assert.strictEqual((await req('PUT', '/A/._hello.txt', {}, 'apple')).status, 201);
  assert.strictEqual(fake.items.length, before);
  assert.ok(!(await names('/A')).some((n) => n.includes('.DS_Store') || n.includes('._')), '不出现在列表');
  assert.strictEqual((await req('GET', '/A/._hello.txt')).body, 'apple');
  assert.strictEqual((await req('PROPFIND', '/A/.DS_Store', { Depth: '0' })).status, 207);
  assert.strictEqual((await req('PROPFIND', '/.metadata_never_index', { Depth: '0' })).status, 404);
  assert.strictEqual((await req('DELETE', '/A/._hello.txt')).status, 204);
  assert.strictEqual((await req('GET', '/A/._hello.txt')).status, 404);
  assert.strictEqual((await req('MKCOL', '/.Spotlight-V100')).status, 201);
  assert.strictEqual((await req('PUT', '/.Spotlight-V100/store.db', {}, 'x')).status, 201);
  assert.strictEqual(fake.items.length, before);
});

test('MKCOL', async () => {
  assert.strictEqual((await req('MKCOL', '/C')).status, 201);
  assert.ok(fake.folders.some((f) => f.name === 'C' && f.parentId === null));
  assert.strictEqual((await req('MKCOL', '/A/sub')).status, 201);
  assert.ok(fake.folders.some((f) => f.name === 'sub' && f.parentId === A.id));
  assert.strictEqual((await req('MKCOL', '/C')).status, 405);
  assert.strictEqual((await req('MKCOL', '/x/y')).status, 409);
  assert.strictEqual((await req('MKCOL', '/D', { 'Content-Length': '3' }, 'abc')).status, 415);
  assert.strictEqual((await req('MKCOL', '/@未分类/z')).status, 403);
});

test('DELETE 与 Eagle 一致：多归属条目在文件夹里只是从该文件夹移除；只剩一个归属时进回收站；文件夹 403', async () => {
  fake.addItem('multi', 'txt', 'm', [A.id, B.id]);
  index.invalidate();
  assert.ok((await names('/B')).includes('/B/multi.txt'));
  assert.strictEqual((await req('DELETE', '/A/multi.txt')).status, 204);
  assert.ok((await names('/B')).includes('/B/multi.txt'), '另一个文件夹里还在');
  assert.ok(!(await names('/A')).includes('/A/multi.txt'));
  assert.strictEqual(fake.trashed.length, 0, '没有进回收站');
  assert.strictEqual((await req('DELETE', '/A/multi.txt')).status, 404);
  assert.strictEqual((await req('DELETE', '/B/multi.txt')).status, 204, '只剩一个归属了');
  assert.strictEqual(fake.trashed.length, 1);
  const r = await req('DELETE', '/A/sub');
  assert.strictEqual(r.status, 403);
  assert.ok(r.body.includes('不提供删除文件夹'));
});

test('DELETE：未分类里的条目整个进回收站', async () => {
  fake.addItem('lonely', 'txt', 'l', []);
  index.invalidate();
  const before = fake.trashed.length;
  assert.strictEqual((await req('DELETE', '/@未分类/lonely.txt')).status, 204);
  assert.strictEqual(fake.trashed.length, before + 1);
});

test('MOVE 条目：改名、跨目录（增量改 folders）、扩展名只读、Overwrite', async () => {
  fake.addItem('mv', 'txt', 'mv', [A.id, B.id]);
  index.invalidate();
  // 同目录改名
  assert.strictEqual((await req('MOVE', '/A/mv.txt', dest('/A/renamed.txt'))).status, 201);
  assert.ok(fs.existsSync(fake.items.find((i) => i.name === 'renamed')!.filePath), '磁盘文件被改名');
  const it = fake.items.find((i) => i.name === 'renamed')!;
  assert.deepStrictEqual(it.folders.sort(), [A.id, B.id].sort(), '改名不动归属');
  // 扩展名只读
  assert.strictEqual((await req('MOVE', '/A/renamed.txt', dest('/A/renamed.md'))).status, 403);
  // 跨目录：只移除源、加入目标，保留 B
  assert.strictEqual((await req('MOVE', '/A/renamed.txt', dest('/A/A1/renamed.txt'))).status, 201);
  const it2 = fake.items.find((i) => i.name === 'renamed')!;
  assert.deepStrictEqual(it2.folders.sort(), [A1.id, B.id].sort());
  // 到 @未分类
  assert.strictEqual((await req('MOVE', '/A/A1/renamed.txt', dest('/@未分类/renamed.txt'))).status, 201);
  assert.deepStrictEqual(fake.items.find((i) => i.name === 'renamed')!.folders, [B.id]);
  // 从 @未分类 移入文件夹
  assert.strictEqual((await req('MOVE', '/@未分类/loose.txt', dest('/A/loose.txt'))).status, 201);
  assert.deepStrictEqual(fake.items.find((i) => i.name === 'loose')!.folders, [A.id]);
  // Overwrite F → 412；T → 目标进回收站
  fake.addItem('dup', 'txt', 'old', [A.id]);
  fake.addItem('dup2', 'txt', 'new', [A.id]);
  index.invalidate();
  assert.strictEqual((await req('MOVE', '/A/dup2.txt', { ...dest('/A/dup.txt'), Overwrite: 'F' })).status, 412);
  const trashedBefore = fake.trashed.length;
  assert.strictEqual((await req('MOVE', '/A/dup2.txt', dest('/A/dup.txt'))).status, 204);
  assert.strictEqual(fake.trashed.length, trashedBefore + 1);
  assert.strictEqual((await req('GET', '/A/dup.txt')).body, 'new');
  // 其他校验
  assert.strictEqual((await req('MOVE', '/A/dup.txt', {})).status, 400);
  assert.strictEqual((await req('MOVE', '/A/dup.txt', { Destination: 'http://other.example/A/x.txt' })).status, 502);
  assert.strictEqual((await req('MOVE', '/A/dup.txt', dest('/A/dup.txt'))).status, 403);
  assert.strictEqual((await req('MOVE', '/A/dup.txt', dest('/nope/dup.txt'))).status, 409);
  assert.strictEqual((await req('MOVE', '/A/dup.txt', dest('/dup.txt'))).status, 403);
});

test('COPY 条目：同名跨目录按引用，改名真复制并带元数据', async () => {
  const src = fake.addItem('cp', 'txt', 'copy me', [A.id]);
  src.tags = ['t1', 't2']; src.star = 3;
  index.invalidate();
  const count = fake.items.length;
  assert.strictEqual((await req('COPY', '/A/cp.txt', dest('/B/cp.txt'))).status, 201);
  assert.strictEqual(fake.items.length, count, '没有新条目');
  assert.deepStrictEqual(src.folders.sort(), [A.id, B.id].sort());
  assert.strictEqual((await req('COPY', '/A/cp.txt', dest('/B/cp.txt'))).status, 204, '已存在则 204');

  assert.strictEqual((await req('COPY', '/A/cp.txt', dest('/A/cp 副本.txt'))).status, 201);
  assert.strictEqual(fake.items.length, count + 1);
  const copy = fake.items.find((i) => i.name === 'cp 副本')!;
  assert.deepStrictEqual(copy.folders, [A.id]);
  assert.deepStrictEqual(copy.tags, ['t1', 't2']);
  assert.strictEqual(copy.star, 3);
  assert.strictEqual(fs.readFileSync(copy.filePath, 'utf8'), 'copy me');
  assert.strictEqual((await req('COPY', '/A', dest('/A2'))).status, 403, '不支持复制文件夹');
});

test('MOVE 文件夹：只能改名；换父级 403（Eagle 接口会让文件夹树不一致）；后代检查、不能覆盖', async () => {
  assert.strictEqual((await req('MOVE', '/C', dest('/C2'))).status, 201);
  assert.ok(fake.folders.some((f) => f.name === 'C2'));
  const parentBefore = fake.folders.find((f) => f.name === 'C2')!.parentId;
  const r = await req('MOVE', '/C2', dest('/B/C2'));
  assert.strictEqual(r.status, 403);
  assert.ok(r.body.includes('不支持移动文件夹'));
  assert.strictEqual(fake.folders.find((f) => f.name === 'C2')!.parentId, parentBefore, '父级没变');
  assert.strictEqual((await req('MOVE', '/A', dest('/A/A1/A'))).status, 409);
  assert.strictEqual((await req('MOVE', '/C2', dest('/A'))).status, 403);
  assert.strictEqual((await req('MOVE', '/C2', { ...dest('/A'), Overwrite: 'F' })).status, 412);
  assert.strictEqual((await req('MOVE', '/C2', dest('/@未分类/C2'))).status, 403);
  assert.strictEqual((await req('MOVE', '/C2', dest('/'))).status, 403);
  assert.strictEqual((await req('MOVE', '/C2', dest('/C3'))).status, 201);
  assert.ok(fake.folders.some((f) => f.name === 'C3'));
});

test('PROPPATCH：E 属性、原子性、dead 属性', async () => {
  const ns = 'urn:eagle-webdav:ns';
  const body = (inner: string) => `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:E="${ns}" xmlns:X="urn:x">${inner}</D:propertyupdate>`;
  const item = fake.items.find((i) => i.name === 'hello')!;
  let r = await req('PROPPATCH', '/A/hello.txt', {}, body('<D:set><D:prop><E:tags>["a","b"]</E:tags><E:star>4</E:star><E:annotation>note &amp; more</E:annotation></D:prop></D:set>'));
  assert.strictEqual(r.status, 207);
  assert.ok(r.body.includes('200 OK'));
  assert.deepStrictEqual(item.tags, ['a', 'b']);
  assert.strictEqual(item.star, 4);
  assert.strictEqual(item.annotation, 'note & more');

  r = await req('PROPFIND', '/A/hello.txt', { Depth: '0' }, `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:E="${ns}"><D:prop><E:tags/><E:star/></D:prop></D:propfind>`);
  assert.ok(r.body.includes('["a","b"]') || r.body.includes('[&quot;a&quot;,&quot;b&quot;]'));

  // 原子性：DAV: 属性只读 → 403，其余 424，不落盘
  r = await req('PROPPATCH', '/A/hello.txt', {}, body('<D:set><D:prop><E:star>1</E:star><D:getetag>x</D:getetag></D:prop></D:set>'));
  assert.ok(r.body.includes('403 Forbidden') && r.body.includes('424 Failed Dependency'));
  assert.strictEqual(item.star, 4);
  r = await req('PROPPATCH', '/A/hello.txt', {}, body('<D:set><D:prop><E:star>9</E:star></D:prop></D:set>'));
  assert.ok(r.body.includes('409 Conflict'));
  r = await req('PROPPATCH', '/A/hello.txt', {}, body('<D:remove><D:prop><E:tags/></D:prop></D:remove>'));
  assert.deepStrictEqual(item.tags, []);

  // dead 属性：只存内存，能读回
  r = await req('PROPPATCH', '/A/hello.txt', {}, body('<D:set><D:prop><X:color>red</X:color></D:prop></D:set>'));
  assert.ok(r.body.includes('200 OK'));
  r = await req('PROPFIND', '/A/hello.txt', { Depth: '0' }, `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:X="urn:x"><D:prop><X:color/></D:prop></D:propfind>`);
  assert.ok(r.body.includes('>red</'));
  assert.strictEqual((await req('PROPPATCH', '/A/nope.txt', {}, body('<D:set><D:prop><X:a>1</X:a></D:prop></D:set>'))).status, 404);
});

test('litmus 补丁：格式错误的 XML 返回 400、单引号命名空间、空命名空间、先删后设、dead 属性随 MOVE / COPY / DELETE', async () => {
  fake.addItem('dp', 'txt', 'x', [A.id]);
  index.invalidate();
  const pf = (inner: string) => `<?xml version="1.0"?><propfind xmlns="DAV:"><prop>${inner}</prop></propfind>`;
  const pp = (inner: string) => `<?xml version="1.0"?><propertyupdate xmlns="DAV:">${inner}</propertyupdate>`;
  assert.strictEqual((await req('PROPFIND', '/A/dp.txt', { Depth: '0' }, '<foo>')).status, 400);
  assert.strictEqual((await req('PROPFIND', '/A/dp.txt', { Depth: '0' }, '<D:propfind xmlns:D="DAV:"><D:prop><bar:foo xmlns:bar=""/></D:prop></D:propfind>')).status, 400);
  assert.strictEqual((await req('PROPPATCH', '/A/dp.txt', {}, '<propertyupdate xmlns="DAV:">')).status, 400);

  // 单引号 xmlns、xmlns=""、同一请求里 remove 后 set 取最后一个
  let r = await req('PROPPATCH', '/A/dp.txt', {}, pp(
    `<remove><prop><k xmlns='urn:q'/></prop></remove><set><prop><k xmlns='urn:q'>x</k></prop></set><set><prop><k xmlns='urn:q'>y</k></prop></set>` +
    `<set><prop><plain xmlns="">v</plain></prop></set>`));
  assert.strictEqual(r.status, 207);
  r = await req('PROPFIND', '/A/dp.txt', { Depth: '0' }, pf(`<k xmlns='urn:q'/><plain xmlns=""/>`));
  assert.ok(r.body.includes('>y</') && r.body.includes('>v</') && !r.body.includes('404'), r.body);

  // MOVE 带走、COPY 复制、DELETE 清掉
  assert.strictEqual((await req('MOVE', '/A/dp.txt', { Destination: 'http://127.0.0.1:' + PORT + enc('/A/dp2.txt') })).status, 201);
  r = await req('PROPFIND', '/A/dp2.txt', { Depth: '0' }, pf(`<k xmlns="urn:q"/>`));
  assert.ok(r.body.includes('>y</'), 'MOVE 后属性还在');
  assert.strictEqual((await req('COPY', '/A/dp2.txt', { Destination: 'http://127.0.0.1:' + PORT + enc('/A/dp3.txt') })).status, 201);
  r = await req('PROPFIND', '/A/dp3.txt', { Depth: '0' }, pf(`<k xmlns="urn:q"/>`));
  assert.ok(r.body.includes('>y</'), 'COPY 后属性被复制');
  assert.strictEqual((await req('DELETE', '/A/dp3.txt')).status, 204);
  await req('PUT', '/A/dp3.txt', {}, 'again');
  r = await req('PROPFIND', '/A/dp3.txt', { Depth: '0' }, pf(`<k xmlns="urn:q"/>`));
  assert.ok(r.body.includes('404 Not Found'), '删除后重建的同名条目不应带着旧属性');
});

test('客户端上传中途断开：不入库，临时文件被清理', async () => {
  const before = fake.items.length;
  const putRoot = path.join(dir, 'put');
  await new Promise<void>((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'PUT', path: enc('/A/aborted.txt'), headers: { ...AUTH, 'Content-Length': '100000' } });
    r.on('error', () => resolve());
    r.write('partial');
    setTimeout(() => { r.destroy(); resolve(); }, 100);
  });
  await new Promise((x) => setTimeout(x, 300));
  assert.strictEqual(fake.items.length, before);
  const left = fs.existsSync(putRoot) ? fs.readdirSync(putRoot) : [];
  assert.deepStrictEqual(left, [], '临时目录应已清理');
  assert.strictEqual((await req('GET', '/A/aborted.txt')).status, 404);
});

test('写入前置条件：If-Match / If-None-Match', async () => {
  fake.addItem('cond', 'txt', 'v1', [A.id]);
  index.invalidate();
  const etag = String((await req('GET', '/A/cond.txt')).headers['etag']);
  assert.strictEqual((await req('PUT', '/A/cond.txt', { 'If-Match': '"nope"' }, 'x')).status, 412);
  assert.strictEqual((await req('PUT', '/A/cond.txt', { 'If-None-Match': '*' }, 'x')).status, 412);
  assert.strictEqual((await req('PUT', '/A/cond-new.txt', { 'If-Match': '"x"' }, 'x')).status, 412, '目标不存在时 If-Match 失败');
  assert.strictEqual((await req('PUT', '/A/cond-new.txt', { 'If-None-Match': '*' }, 'x')).status, 201);
  assert.strictEqual((await req('DELETE', '/A/cond.txt', { 'If-Match': '"nope"' })).status, 412);
  assert.strictEqual((await req('MOVE', '/A/cond.txt', { 'If-Match': '"nope"', ...dest('/A/cond2.txt') })).status, 412);
  assert.strictEqual((await req('PUT', '/A/cond.txt', { 'If-Match': etag }, 'v2')).status, 204);
  assert.strictEqual((await req('DELETE', '/A/cond.txt', { 'If-Match': '*' })).status, 204);
});

test('E:width / E:height 属性', async () => {
  const it = fake.addItem('pic', 'png', 'P', [A.id]);
  it.width = 640; it.height = 480;
  index.invalidate();
  const r = await req('PROPFIND', '/A/pic.png', { Depth: '0' }, '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:E="urn:eagle-webdav:ns"><D:prop><E:width/><E:height/><E:id/></D:prop></D:propfind>');
  assert.ok(r.body.includes('>640<') && r.body.includes('>480<') && r.body.includes(it.id));
});

test('资源库切换后影子条目被清空', async () => {
  await req('PUT', '/A/.DS_Store', {}, 'junk');
  router.reset();
  assert.strictEqual((await req('GET', '/A/.DS_Store')).status, 404);
});

test('dispose 清理临时目录', () => {
  router.dispose();
  assert.ok(!fs.existsSync(router.shadow.dir));
});

test('停止', async () => { await server.stop(); });
