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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewdav-t-'));
const store = new ConfigStore(dir);
store.load();
store.update({ host: '127.0.0.1', port: 0, username: 'u' });
store.setPassword('p');

const fake = new FakeEagleAdapter();
const F = fake.addFolder('图');
const a = fake.addItem('cat', 'png', 'CAT', [F.id]); a.tags = ['动物', 'cute'];
const b = fake.addItem('dog', 'png', 'DOG', []); b.tags = ['动物'];
fake.addItem('plain', 'png', 'P', [F.id]);

const logger = new RingLogger();
const index = new LibraryIndex(fake);
let allView = true;
const router = new DavRouter(fake, index, logger, { allView: () => allView, tmpRoot: path.join(dir, 'put') });
const server = new DavServer({ getConfig: () => store.get(), logger, handler: (x, y) => router.handle(x, y) });

const AUTH = { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };
const enc = (p: string) => p.split('/').map((x) => encodeURIComponent(x)).join('/');
function req(method: string, p: string, headers: http.OutgoingHttpHeaders = {}, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: enc(p), headers: { ...AUTH, ...headers } }, (res) => {
      const c: Buffer[] = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(c).toString() }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const dest = (p: string) => ({ Destination: `http://127.0.0.1:${PORT}${enc(p)}` });
const names = async (p: string) =>
  Array.from((await req('PROPFIND', p, { Depth: '1' })).body.matchAll(/<D:href>([^<]*)<\/D:href>/g)).map((m) => decodeURIComponent(m[1])).slice(1);

test('启动', async () => { await server.start(); PORT = server.listenInfo!.port; });

const unfiledNames = async () => (await names('/@未分类')).map((x) => x.split('/').pop());
const folderOf = (name: string) => fake.items.find((i) => `${i.name}.${i.ext}` === name)?.folders;

test('@全部：平铺列出全库条目，可读，多文件夹条目只出现一次', async () => {
  const c = fake.addItem('multi', 'png', 'M', [F.id]); c.folders = [F.id, fake.addFolder('另一个').id];
  index.invalidate();
  assert.deepStrictEqual(await names('/'), ['/@未分类/', '/@全部/', '/图/', '/另一个/']);
  assert.deepStrictEqual((await names('/@全部')).sort(), ['/@全部/cat.png', '/@全部/dog.png', '/@全部/multi.png', '/@全部/plain.png']);
  assert.strictEqual((await req('GET', '/@全部/dog.png')).body, 'DOG');
});

test('@全部 新增文件：落在未分类，同时出现在 @全部 与 @未分类', async () => {
  assert.strictEqual((await req('PUT', '/@全部/new.png', {}, 'NEW')).status, 201);
  assert.deepStrictEqual(folderOf('new.png'), []);
  assert.ok((await names('/@全部')).includes('/@全部/new.png'));
  assert.ok((await unfiledNames()).includes('new.png'));
  assert.strictEqual((await req('GET', '/@全部/new.png')).body, 'NEW');
});

test('@全部 新增文件：Finder 式「0 字节占位 → 带内容」只产生一个条目', async () => {
  const before = fake.items.length;
  assert.strictEqual((await req('PUT', '/@全部/finder.png', { 'Content-Length': '0' }, '')).status, 201);
  assert.strictEqual(fake.items.length, before, '占位不入库');
  assert.strictEqual((await req('PUT', '/@全部/finder.png', {}, 'FINDER')).status, 201);
  assert.strictEqual(fake.items.length, before + 1);
  assert.deepStrictEqual(folderOf('finder.png'), []);
});

test('@全部 不能覆盖、删除、改名、移动、改属性、新建文件夹', async () => {
  const n = fake.items.length;
  assert.strictEqual((await req('PUT', '/@全部/dog.png', {}, 'x')).status, 403);
  assert.strictEqual((await req('DELETE', '/@全部/dog.png')).status, 403);
  assert.strictEqual((await req('MKCOL', '/@全部/新')).status, 403);
  assert.strictEqual((await req('MOVE', '/@全部/dog.png', dest('/图/dog.png'))).status, 403);
  assert.strictEqual((await req('MOVE', '/@全部/dog.png', dest('/@全部/dog2.png'))).status, 403);
  assert.strictEqual((await req('MOVE', '/图/plain.png', dest('/@全部/plain.png'))).status, 403);
  assert.strictEqual((await req('PROPPATCH', '/@全部/dog.png', {}, '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><X:a xmlns:X="urn:x">1</X:a></D:prop></D:set></D:propertyupdate>')).status, 403);
  assert.strictEqual(fake.items.length, n);
  assert.ok(fake.items.every((i) => i.name !== 'dog2'));
});

test('@全部 COPY 进来：同名同一条目什么都不做；换名是落在未分类的新素材；撞上别的条目不能覆盖', async () => {
  const n = fake.items.length;
  assert.strictEqual((await req('COPY', '/图/plain.png', dest('/@全部/plain.png'))).status, 204);
  assert.strictEqual(fake.items.length, n);
  assert.strictEqual((await req('COPY', '/图/plain.png', dest('/@全部/plain-copy.png'))).status, 201);
  assert.strictEqual(fake.items.length, n + 1);
  assert.deepStrictEqual(folderOf('plain-copy.png'), []);
  assert.strictEqual((await req('COPY', '/图/plain.png', dest('/@全部/dog.png'))).status, 403);
  assert.strictEqual(fake.items.length, n + 1);
});

test('从 @全部 COPY 出来：同名按引用加入目标文件夹', async () => {
  assert.strictEqual((await req('COPY', '/@全部/dog.png', dest('/图/dog.png'))).status, 201);
  assert.deepStrictEqual(b.folders, [F.id]);
});

test('关闭视图后消失', async () => {
  allView = false;
  index.invalidate();
  assert.deepStrictEqual(await names('/'), ['/@未分类/', '/图/', '/另一个/']);
  assert.strictEqual((await req('PROPFIND', '/@全部', { Depth: '0' })).status, 404);
});

test('停止', async () => { await server.stop(); });
