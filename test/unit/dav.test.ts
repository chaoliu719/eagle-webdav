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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewdav-'));
const store = new ConfigStore(dir);
store.load();
store.update({ host: '127.0.0.1', port: 0, username: 'u' });
store.setPassword('p');

const fake = new FakeEagleAdapter();
const trip = fake.addFolder('旅行');
const sub = fake.addFolder('东京', trip.id);
fake.addItem('海报', 'jpg', '0123456789', [trip.id]);
fake.addItem('海报', 'jpg', 'second-file', [trip.id]);
fake.addItem('note', 'txt', 'hello eagle', [sub.id, trip.id]);
fake.addItem('loose', 'png', 'PNGDATA', []);

const logger = new RingLogger();
const index = new LibraryIndex(fake);
const router = new DavRouter(fake, index, logger);
const server = new DavServer({ getConfig: () => store.get(), logger, handler: (a, b) => router.handle(a, b) });

const AUTH = { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };
function req(method: string, p: string, headers: http.OutgoingHttpHeaders = {}, body?: string) {
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
const enc = (p: string) => p.split('/').map((x) => (x.includes('%') ? x : encodeURIComponent(x))).join('/');
const hrefs = (xml: string) => Array.from(xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)).map((m) => decodeURIComponent(m[1]));

test('启动', async () => { await server.start(); PORT = server.listenInfo!.port; });

test('PROPFIND 根目录与子目录', async () => {
  let r = await req('PROPFIND', '/', { Depth: '1' });
  assert.strictEqual(r.status, 207);
  assert.match(String(r.headers['content-type']), /^text\/xml; charset=utf-8$/i);
  assert.deepStrictEqual(hrefs(r.body), ['/', '/@未分类/', '/旅行/']);
  assert.ok(!r.body.includes('quota'));

  r = await req('PROPFIND', '/旅行', { Depth: '1' });
  assert.deepStrictEqual(hrefs(r.body).slice(0, 4), ['/旅行/', '/旅行/东京/', '/旅行/海报.jpg', hrefs(r.body)[3]]);
  assert.match(hrefs(r.body)[3], /^\/旅行\/海报 ~[A-Z0-9]{6}\.jpg$/);
  assert.strictEqual(hrefs(r.body)[4], '/旅行/note.txt');
  assert.strictEqual(hrefs(r.body).length, 5);
  assert.ok(hrefs(r.body).includes('/旅行/海报.jpg'));
  assert.ok(r.body.includes('<D:getcontentlength>10</D:getcontentlength>'));
  assert.ok(/<D:creationdate>[^<.]*Z<\/D:creationdate>/.test(r.body), '无毫秒');

  r = await req('PROPFIND', '/@未分类', { Depth: '1' });
  assert.deepStrictEqual(hrefs(r.body), ['/@未分类/', '/@未分类/loose.png']);
  r = await req('PROPFIND', '/不存在', { Depth: '0' });
  assert.strictEqual(r.status, 404);
  r = await req('PROPFIND', '/旅行/东京', { Depth: 'infinity' });
  assert.strictEqual(r.status, 403);
  assert.ok(r.body.includes('propfind-finite-depth'));
});

test('多文件夹条目在每处出现，且 NFD 路径可解析', async () => {
  const a = await req('PROPFIND', '/旅行/东京', { Depth: '1' });
  assert.ok(hrefs(a.body).includes('/旅行/东京/note.txt'));
  const nfd = '/' + encodeURIComponent('东京'.normalize('NFD'));
  assert.strictEqual((await req('PROPFIND', '/旅行' + nfd, { Depth: '0' })).status, 207);
});

test('PROPFIND prop 请求：未知属性 404 propstat、DOCTYPE 400', async () => {
  const body = '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:X="urn:x"><D:prop><D:getcontentlength/><X:foo/></D:prop></D:propfind>';
  let r = await req('PROPFIND', '/旅行/海报.jpg', { Depth: '0' }, body);
  assert.ok(r.body.includes('<D:getcontentlength>10') && r.body.includes('404 Not Found') && r.body.includes('urn:x'));
  r = await req('PROPFIND', '/', { Depth: '0' }, '<!DOCTYPE x [<!ENTITY a "b">]><propfind xmlns="DAV:"><allprop/></propfind>');
  assert.strictEqual(r.status, 400);
});

test('GET / HEAD / Range / 条件请求', async () => {
  let r = await req('GET', '/旅行/海报.jpg');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body, '0123456789');
  assert.strictEqual(r.headers['accept-ranges'], 'bytes');
  const etag = String(r.headers['etag']);

  r = await req('HEAD', '/旅行/海报.jpg');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-length'], '10');
  assert.strictEqual(r.body, '');

  r = await req('GET', '/旅行/海报.jpg', { Range: 'bytes=2-4' });
  assert.strictEqual(r.status, 206); assert.strictEqual(r.body, '234'); assert.strictEqual(r.headers['content-range'], 'bytes 2-4/10');
  r = await req('GET', '/旅行/海报.jpg', { Range: 'bytes=-3' });
  assert.strictEqual(r.body, '789');
  r = await req('GET', '/旅行/海报.jpg', { Range: 'bytes=7-' });
  assert.strictEqual(r.body, '789');
  r = await req('GET', '/旅行/海报.jpg', { Range: 'bytes=0-1,3-4' });
  assert.strictEqual(r.status, 200);
  r = await req('GET', '/旅行/海报.jpg', { Range: 'bytes=50-' });
  assert.strictEqual(r.status, 416); assert.strictEqual(r.headers['content-range'], 'bytes */10');
  r = await req('GET', '/旅行/海报.jpg', { 'If-None-Match': etag });
  assert.strictEqual(r.status, 304);
  r = await req('GET', '/旅行/海报.jpg', { 'If-Match': '"nope"' });
  assert.strictEqual(r.status, 412);
  r = await req('GET', '/旅行/海报.jpg', { Range: 'bytes=2-4', 'If-Range': '"other"' });
  assert.strictEqual(r.status, 200);
  r = await req('GET', '/旅行/海报.jpg', { Range: 'bytes=2-4', 'If-Range': etag });
  assert.strictEqual(r.status, 206);

  r = await req('GET', '/旅行');
  assert.strictEqual(r.status, 200); assert.ok(r.body.includes('<ul>'));
  r = await req('GET', '/旅行/nope.txt');
  assert.strictEqual(r.status, 404);
});

test('库外文件被拒绝', async () => {
  const outside = path.join(dir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const it = fake.addItem('evil', 'txt', 'x', []);
  it.filePath = outside;
  index.invalidate();
  const r = await req('GET', '/@未分类/evil.txt');
  assert.strictEqual(r.status, 404);
});

test('改名后 GET 使用最新 filePath', async () => {
  const it = fake.addItem('before', 'txt', 'v1', []);
  index.invalidate();
  assert.strictEqual((await req('GET', '/@未分类/before.txt')).body, 'v1');
  const np = path.join(path.dirname(it.filePath), 'after.txt');
  fs.renameSync(it.filePath, np);
  it.filePath = np; it.name = 'after';
  index.invalidate();
  assert.strictEqual((await req('GET', '/@未分类/after.txt')).body, 'v1');
});

test('索引在资源库变更后失效', async () => {
  fake.addItem('later', 'txt', 'x', []);
  await new Promise((r) => setTimeout(r, 1600));
  const r = await req('PROPFIND', '/@未分类', { Depth: '1' });
  assert.ok(hrefs(r.body).includes('/@未分类/later.txt'));
});

test('OPTIONS 的 Allow 按资源类型', async () => {
  assert.ok(!String((await req('OPTIONS', '/旅行')).headers['allow']).includes('GET'));
  assert.ok(String((await req('OPTIONS', '/旅行/海报.jpg')).headers['allow']).includes('GET'));
  assert.strictEqual((await req('OPTIONS', '/旅行/nope')).headers['allow'], 'OPTIONS, LOCK, PUT, MKCOL');
});

test('LOCK / 刷新 / UNLOCK 与 lockdiscovery', async () => {
  const lockBody = '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>me</D:owner></D:lockinfo>';
  let r = await req('LOCK', '/旅行/海报.jpg', { Depth: '0', Timeout: 'Second-600' }, lockBody);
  assert.strictEqual(r.status, 200);
  const token = /<opaquelocktoken:([^>]+)>/.exec(String(r.headers['lock-token']))![1];
  assert.ok(r.body.includes('Second-600'));

  r = await req('PROPFIND', '/旅行/海报.jpg', { Depth: '0' });
  assert.ok(r.body.includes(token));

  // 设计决定：永不拒绝加锁，已有锁时也发新令牌（Finder 崩溃留下的旧锁不能把自己锁死）
  r = await req('LOCK', '/旅行/海报.jpg', { Depth: '0' }, lockBody);
  assert.strictEqual(r.status, 200);
  assert.notStrictEqual(/<opaquelocktoken:([^>]+)>/.exec(String(r.headers['lock-token']))![1], token);
  r = await req('LOCK', '/旅行/海报.jpg', { If: `(<opaquelocktoken:${token}>)`, Timeout: 'Second-300' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes('Second-300'));

  r = await req('UNLOCK', '/旅行/海报.jpg', { 'Lock-Token': `<opaquelocktoken:${token}>` });
  assert.strictEqual(r.status, 204);
  r = await req('UNLOCK', '/旅行/海报.jpg', { 'Lock-Token': `<opaquelocktoken:${token}>` });
  assert.strictEqual(r.status, 409);
  r = await req('LOCK', '/旅行/新文件.txt', { Depth: '0' }, lockBody);
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await req('PROPFIND', '/旅行/新文件.txt', { Depth: '0' })).status, 207, '锁定空资源会留下占位');
  assert.strictEqual((await req('LOCK', '/没有/这个目录/x.txt', { Depth: '0' }, lockBody)).status, 409);
});

test('停止', async () => { await server.stop(); });
