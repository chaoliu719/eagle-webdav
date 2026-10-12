import assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { ConfigStore } from '../../src/config/config';
import { DavRouter } from '../../src/dav/router';
import { FakeEagleAdapter } from '../../src/eagle/fakeAdapter';
import { LibraryIndex } from '../../src/index/libraryIndex';
import { DavServer } from '../../src/http/server';
import { RingLogger } from '../../src/util/log';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewdav-'));
const store = new ConfigStore(dir);
store.load();
store.update({ host: '127.0.0.1', port: 0, username: 'u' });
// 端口由系统分配，避免与本机其他进程（含残留的测试进程）串线
let PORT = 0;
store.setPassword('p');
const logger = new RingLogger();
const fake = new FakeEagleAdapter();
const router = new DavRouter(fake, new LibraryIndex(fake), logger);
const handler = (rq: http.IncomingMessage, rs: http.ServerResponse) => router.handle(rq, rs);
const server = new DavServer({ getConfig: () => store.get(), logger, handler });

function req(method: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: '/', headers }, (res) => {
      const c: Buffer[] = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(c).toString() }));
    });
    r.on('error', reject);
    r.end();
  });
}
const AUTH = { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };


test('配置文件权限为 0600', () => {
  assert.strictEqual(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
});

test('没设管理密码：不要求认证，任何访问都是管理账号，也可以监听非本机地址', async () => {
  const s = new DavServer({
    getConfig: () => ({ ...store.get(), host: '127.0.0.1', port: 0, passwordHash: null }), logger,
    handler: (a, b) => router.handle(a, b)
  });
  await s.start();
  const p1 = s.listenInfo!.port;
  try {
    const r = await new Promise<number>((resolve, reject) => {
      http.request({ host: '127.0.0.1', port: p1, method: 'OPTIONS', path: '/' }, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject).end();
    });
    assert.strictEqual(r, 200);
  } finally {
    await s.stop();
  }
  // 监听非本机地址也不再要求先设密码
  const wide = new DavServer({ getConfig: () => ({ ...store.get(), host: '0.0.0.0', port: 0, passwordHash: null }), logger, handler });
  await wide.start();
  await wide.stop();
});

test('只有传输类请求才计入防休眠活动，浏览与心跳不计', async () => {
  const events: string[] = [];
  const s = new DavServer({
    getConfig: () => ({ ...store.get(), port: 0, passwordHash: null }), logger, handler,
    activity: { begin: () => events.push('begin'), end: () => events.push('end') }
  });
  await s.start();
  const p2 = s.listenInfo!.port;
  const call = (method: string, p = '/') => new Promise<void>((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: p2, method, path: p }, (res) => { res.resume(); res.on('end', () => resolve()); }).on('error', reject).end();
  });
  try {
    await call('OPTIONS'); await call('PROPFIND'); await call('LOCK'); await call('HEAD');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(events, [], 'OPTIONS / PROPFIND / LOCK / HEAD 不计入');
    await call('GET', '/nope.txt'); await call('PUT', '/nope.txt');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(events, ['begin', 'end', 'begin', 'end'], 'GET / PUT 计入，且成对');
  } finally {
    await s.stop();
  }
});

test('认证、OPTIONS、501、503', async () => {
  await server.start();
  PORT = server.listenInfo!.port;
  let r = await req('OPTIONS');
  assert.strictEqual(r.status, 401);
  assert.match(String(r.headers['www-authenticate']), /^Basic realm=/);
  r = await req('OPTIONS', AUTH);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['dav'], '1, 2');
  r = await req('PROPFIND', AUTH);
  assert.strictEqual(r.status, 403);
  r = await req('REPORT', AUTH);
  assert.strictEqual(r.status, 501);
  server.setSwitching(true);
  r = await req('OPTIONS', AUTH);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.headers['retry-after'], '5');
  server.setSwitching(false);
  assert.ok(logger.recent().some((e) => e.method === 'OPTIONS' && e.status === 200));
  assert.ok(logger.recent().every((e) => !JSON.stringify(e).includes('Basic')));
});

test('停止后端口释放', async () => {
  await server.stop();
  await assert.rejects(req('OPTIONS', AUTH));
});
