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
let tagsView = true;
const router = new DavRouter(fake, index, logger, { tagsView: () => tagsView, tmpRoot: path.join(dir, 'put') });
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

test('@标签 视图：列出标签与条目，可读', async () => {
  assert.deepStrictEqual(await names('/'), ['/@未分类/', '/@标签/', '/图/']);
  assert.deepStrictEqual((await names('/@标签')).sort(), ['/@标签/cute/', '/@标签/动物/']);
  assert.deepStrictEqual((await names('/@标签/动物')).sort(), ['/@标签/动物/cat.png', '/@标签/动物/dog.png']);
  assert.strictEqual((await req('GET', '/@标签/动物/dog.png')).body, 'DOG');
});

test('@标签 视图只读：写入类方法一律 403', async () => {
  assert.strictEqual((await req('PUT', '/@标签/动物/new.png', {}, 'x')).status, 403);
  assert.strictEqual((await req('PUT', '/@标签/动物/dog.png', {}, 'x')).status, 403);
  assert.strictEqual((await req('MKCOL', '/@标签/新标签')).status, 403);
  assert.strictEqual((await req('DELETE', '/@标签/动物/dog.png')).status, 403);
  assert.strictEqual((await req('MOVE', '/@标签/动物/dog.png', dest('/图/dog.png'))).status, 403);
  assert.strictEqual((await req('MOVE', '/图/plain.png', dest('/@标签/动物/plain.png'))).status, 403);
  assert.strictEqual((await req('COPY', '/图/plain.png', dest('/@标签/动物/plain.png'))).status, 403);
  assert.strictEqual((await req('PROPPATCH', '/@标签/动物/dog.png', {}, '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><X:a xmlns:X="urn:x">1</X:a></D:prop></D:set></D:propertyupdate>')).status, 403);
  assert.strictEqual(fake.items.length, 3);
  assert.deepStrictEqual(b.tags, ['动物']);
});

test('从标签视图 COPY 出来：同名按引用加入目标文件夹', async () => {
  assert.strictEqual((await req('COPY', '/@标签/动物/dog.png', dest('/图/dog.png'))).status, 201);
  assert.deepStrictEqual(b.folders, [F.id]);
});

test('新增标签后失效重建；关闭视图后消失', async () => {
  b.tags = ['动物', '新'];
  fake.modificationTime++;
  await new Promise((r) => setTimeout(r, 1600));
  assert.ok((await names('/@标签')).includes('/@标签/新/'));
  tagsView = false;
  index.invalidate();
  assert.deepStrictEqual(await names('/'), ['/@未分类/', '/图/']);
  assert.strictEqual((await req('PROPFIND', '/@标签', { Depth: '0' })).status, 404);
});

test('停止', async () => { await server.stop(); });
