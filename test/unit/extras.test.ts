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
import { Bonjour } from '../../src/util/bonjour';
import { friendlyClient, summarizeClients } from '../../src/util/clients';
import { RingLogger, type RequestEntry } from '../../src/util/log';
import { SleepGuard } from '../../src/util/sleepGuard';

const basic = (s: string) => 'Basic ' + Buffer.from(s).toString('base64');

test('没设管理密码时不要求认证；设了则校验账号密码', () => {
  const a = new Authenticator();
  const none = { username: 'eagle', passwordHash: null };
  assert.strictEqual(a.check(undefined, '1.1.1.1', none), 'ok');
  assert.strictEqual(a.check(basic('x:y'), '1.1.1.1', none), 'ok');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewdav-x-'));
  const store = new ConfigStore(dir);
  store.load();
  store.setPassword('adminpw');
  assert.strictEqual(a.check(basic('eagle:adminpw'), '2.2.2.2', store.get()), 'ok');
  assert.strictEqual(a.check(basic('eagle:bad'), '2.2.2.2', store.get()), 'denied');
  assert.strictEqual(a.check(undefined, '2.2.2.2', store.get()), 'denied');
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
  let argv: string[] = [];
  let enabled = true;
  const g = new SleepGuard({
    enabled: () => enabled, idleMs: 30, platform: 'darwin',
    spawnFn: ((cmd: string, args: string[]) => { assert.strictEqual(cmd, 'caffeinate'); argv = args; const c = fakeChild().child; spawned.push(c); return c; }) as never
  });
  g.begin(); g.begin();
  assert.ok(g.active);
  assert.strictEqual(spawned.length, 1, '只起一个进程');
  assert.ok(argv.includes('-w'), 'caffeinate 绑定到当前进程，避免遗留');
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
  const e = (n: number, ip: string, ua: string, agoMs: number): RequestEntry =>
    ({ n, t: new Date(now - agoMs).toISOString(), ip, method: 'GET', url: '/', status: 200, ms: 5, ua });
  const list = summarizeClients([
    e(1, '::ffff:192.168.0.5', 'WebDAVFS/3', 1000), e(2, '::ffff:192.168.0.5', 'WebDAVFS/3', 500),
    e(3, '192.168.0.9', 'Infuse/8', 100), e(4, '192.168.0.7', 'curl/8', 10 * 60_000)
  ], now);
  assert.deepStrictEqual(list.map((c) => [c.client, c.ip, c.requests]), [['Infuse', '192.168.0.9', 1], ['Finder', '192.168.0.5', 2]]);
});

test('重复添加提示：给出提示，条目入库后自动撤销', async () => {
  const fake = new FakeEagleAdapter();
  const logger = new RingLogger();
  const notified: string[] = [];
  logger.onNotice = (n) => notified.push(n.message);
  const ctx = { adapter: fake, index: new LibraryIndex(fake), logger } as unknown as DavContext;
  watchPending(ctx, 'LATER000001', '海报.jpg', null, 20, 5000);
  assert.strictEqual(logger.activeNotices().length, 1);
  assert.strictEqual(notified.length, 1);
  assert.match(notified[0], /重复添加提示/);
  watchPending(ctx, 'LATER000001', '海报.jpg', null, 20, 5000); // 同一个 key 不重复通知
  assert.strictEqual(notified.length, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(logger.activeNotices().length, 1, '条目还没入库，提示保留');
  fake.items.push({ id: 'LATER000001', name: 'x', ext: 'jpg', size: 1, folders: [], tags: [], importedAt: 1, modifiedAt: 1, star: 0, annotation: '', url: '', filePath: '/x' });
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(logger.activeNotices().length, 0, '入库后撤销提示');
});
