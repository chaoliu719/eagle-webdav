import assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { ConfigStore } from '../../src/config/config';
import type { DavContext } from '../../src/dav/context';
import { watchPending } from '../../src/dav/handlers/common';
import { DavRouter } from '../../src/dav/router';
import { FakeEagleAdapter } from '../../src/eagle/fakeAdapter';
import { Authenticator } from '../../src/http/auth';
import { DavServer } from '../../src/http/server';
import { LibraryIndex } from '../../src/index/libraryIndex';
import { qrSvg } from '../../src/ui/status';
import { Bonjour } from '../../src/util/bonjour';
import { friendlyClient, summarizeClients } from '../../src/util/clients';
import { RingLogger, type RequestEntry } from '../../src/util/log';
import { SleepGuard } from '../../src/util/sleepGuard';

const basic = (s: string) => 'Basic ' + Buffer.from(s).toString('base64');

test('认证区分管理账号与只读账号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewdav-x-'));
  const store = new ConfigStore(dir);
  store.load();
  store.setPassword('adminpw');
  store.setReadonlyPassword('viewpw');
  const cfg = store.get();
  const a = new Authenticator();
  assert.deepStrictEqual(a.login(basic('eagle:adminpw'), '1.1.1.1', cfg), { result: 'ok', role: 'admin' });
  assert.deepStrictEqual(a.login(basic('viewer:viewpw'), '1.1.1.1', cfg), { result: 'ok', role: 'readonly' });
  assert.strictEqual(a.login(basic('viewer:adminpw'), '1.1.1.1', cfg).result, 'denied');
  assert.strictEqual(a.login(basic('eagle:viewpw'), '1.1.1.1', cfg).result, 'denied');
  // 未设置只读密码时，只读账号不可用
  store.update({ readonlyPasswordHash: null });
  assert.strictEqual(a.login(basic('viewer:viewpw'), '2.2.2.2', store.get()).result, 'denied');
  // 与管理账号同名的只读账号配置无效
  store.setReadonlyPassword('same');
  store.update({ readonlyUsername: 'eagle' });
  assert.strictEqual(a.login(basic('eagle:same'), '3.3.3.3', store.get()).result, 'denied');
});

test('只读账号：写入类方法 403，读取正常，以 DAV: 1 通告', async () => {
  const PORT = 41694;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewdav-ro-'));
  const store = new ConfigStore(dir);
  store.load();
  store.update({ host: '127.0.0.1', port: PORT, username: 'u' });
  store.setPassword('p');
  store.setReadonlyPassword('ro');
  const fake = new FakeEagleAdapter();
  const F = fake.addFolder('A');
  fake.addItem('x', 'txt', 'hello', [F.id]);
  const logger = new RingLogger();
  const router = new DavRouter(fake, new LibraryIndex(fake), logger, { tmpRoot: path.join(dir, 'put') });
  const server = new DavServer({ getConfig: () => store.get(), logger, handler: (a, b, r) => router.handle(a, b, r) });
  await server.start();
  const req = (method: string, p: string, headers: http.OutgoingHttpHeaders = {}, body?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { Authorization: basic('viewer:ro'), ...headers } }, (res) => {
      const c: Buffer[] = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(c).toString() }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
  try {
    assert.strictEqual((await req('GET', '/A/x.txt')).body, 'hello');
    assert.strictEqual((await req('PROPFIND', '/A', { Depth: '1' })).status, 207);
    const o = await req('OPTIONS', '/A');
    assert.strictEqual(o.headers['dav'], '1');
    assert.ok(!/PUT|DELETE|MOVE|COPY|MKCOL|PROPPATCH/.test(String(o.headers['allow'])));
    for (const [m, p, h] of [
      ['PUT', '/A/new.txt', {}], ['MKCOL', '/B', {}], ['DELETE', '/A/x.txt', {}],
      ['MOVE', '/A/x.txt', { Destination: `http://127.0.0.1:${PORT}/A/y.txt` }],
      ['COPY', '/A/x.txt', { Destination: `http://127.0.0.1:${PORT}/A/z.txt` }],
      ['PROPPATCH', '/A/x.txt', {}]
    ] as Array<[string, string, http.OutgoingHttpHeaders]>) {
      assert.strictEqual((await req(m, p, h, m === 'PUT' ? 'x' : undefined)).status, 403, m);
    }
    assert.strictEqual((await req('LOCK', '/A/none.txt', { Depth: '0' }, '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope></D:lockinfo>')).status, 403);
    assert.strictEqual((await req('LOCK', '/A/x.txt', { Depth: '0' }, '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope></D:lockinfo>')).status, 200);
    assert.strictEqual(fake.items.length, 1, '没有任何改动');
    assert.ok(logger.recent().some((e) => e.role === 'readonly'), '请求日志记录角色');
  } finally {
    await server.stop();
  }
});

class FakeChild extends EventEmitter {
  killed = false;
  kill(): void { this.killed = true; this.emit('exit'); }
}
function fakeChild(): { child: FakeChild } {
  return { child: new FakeChild() };
}

test('防休眠：请求期间保持 caffeinate，空闲后放开，可关闭', async () => {
  const spawned: Array<ReturnType<typeof fakeChild>['child']> = [];
  let enabled = true;
  const g = new SleepGuard({
    enabled: () => enabled, idleMs: 30, platform: 'darwin',
    spawnFn: ((cmd: string, args: string[]) => { assert.strictEqual(cmd, 'caffeinate'); assert.deepStrictEqual(args, ['-i']); const c = fakeChild().child; spawned.push(c); return c; }) as never
  });
  g.begin(); g.begin();
  assert.ok(g.active);
  assert.strictEqual(spawned.length, 1, '只起一个进程');
  g.end();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(g.active, '还有一个请求在处理，不放开');
  g.end();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!g.active, '空闲后放开');
  assert.ok(spawned[0].killed);
  enabled = false;
  g.begin(); g.end();
  assert.ok(!g.active, '关闭选项后不再阻止休眠');
  const other = new SleepGuard({ enabled: () => true, platform: 'linux', spawnFn: (() => { throw new Error('不应调用'); }) as never });
  other.begin();
  assert.ok(!other.active);
  g.release();
});

test('Bonjour：注册 _webdav._tcp，停止时结束进程，非 macOS 不注册', () => {
  let args: string[] = [];
  const kids: Array<ReturnType<typeof fakeChild>['child']> = [];
  const b = new Bonjour({
    platform: 'darwin', hostname: () => 'My-Mac.local',
    spawnFn: ((cmd: string, a: string[]) => { assert.strictEqual(cmd, 'dns-sd'); args = a; const c = fakeChild().child; kids.push(c); return c; }) as never
  });
  assert.ok(b.start(41600));
  assert.strictEqual(b.name, 'Eagle WebDAV (My-Mac)');
  assert.deepStrictEqual(args.slice(0, 5), ['-R', 'Eagle WebDAV (My-Mac)', '_webdav._tcp', 'local', '41600']);
  assert.ok(b.active);
  b.start(41601); // 重新注册会先结束旧进程
  assert.ok(kids[0].killed && kids.length === 2);
  b.stop();
  assert.ok(!b.active && kids[1].killed);
  const n = new Bonjour({ platform: 'linux', spawnFn: (() => { throw new Error('不应调用'); }) as never });
  assert.ok(!n.start(1));
});

test('客户端识别与汇总', () => {
  assert.strictEqual(friendlyClient('WebDAVFS/3.0.0 (03008000) Darwin/25.0.0'), 'Finder');
  assert.strictEqual(friendlyClient('Infuse-Direct/8.3'), 'Infuse');
  assert.strictEqual(friendlyClient('rclone/v1.70'), 'rclone');
  assert.strictEqual(friendlyClient('Lavf/61.1.100'), 'ffmpeg');
  assert.strictEqual(friendlyClient(undefined), '未知客户端');
  const now = Date.now();
  const e = (n: number, ip: string, ua: string, agoMs: number, role?: string): RequestEntry =>
    ({ n, t: new Date(now - agoMs).toISOString(), ip, method: 'GET', url: '/', status: 200, ms: 5, ua, role });
  const list = summarizeClients([
    e(1, '::ffff:192.168.0.5', 'WebDAVFS/3', 1000, 'admin'), e(2, '::ffff:192.168.0.5', 'WebDAVFS/3', 500, 'admin'),
    e(3, '192.168.0.9', 'Infuse/8', 100, 'readonly'), e(4, '192.168.0.7', 'curl/8', 10 * 60_000)
  ], now);
  assert.deepStrictEqual(list.map((c) => [c.client, c.ip, c.requests, c.role]), [['Infuse', '192.168.0.9', 1, 'readonly'], ['Finder', '192.168.0.5', 2, 'admin']]);
});

test('重复添加提示：给出提示，条目入库后自动撤销', async () => {
  const fake = new FakeEagleAdapter();
  const logger = new RingLogger();
  const notified: string[] = [];
  logger.onNotice = (n) => notified.push(n.message);
  const ctx = { adapter: fake, index: new LibraryIndex(fake), logger } as unknown as DavContext;
  watchPending(ctx, 'LATER000001', '海报.jpg', 20, 5000);
  assert.strictEqual(logger.activeNotices().length, 1);
  assert.strictEqual(notified.length, 1);
  assert.match(notified[0], /重复添加提示/);
  watchPending(ctx, 'LATER000001', '海报.jpg', 20, 5000); // 同一个 key 不重复通知
  assert.strictEqual(notified.length, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(logger.activeNotices().length, 1, '条目还没入库，提示保留');
  fake.items.push({ id: 'LATER000001', name: 'x', ext: 'jpg', size: 1, folders: [], tags: [], importedAt: 1, modifiedAt: 1, star: 0, annotation: '', url: '', filePath: '/x' });
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(logger.activeNotices().length, 0, '入库后撤销提示');
});

test('二维码：生成白底 SVG', () => {
  const svg = qrSvg('http://192.168.0.103:41600/');
  assert.match(svg, /^<svg/);
  assert.ok(svg.length > 500);
});
