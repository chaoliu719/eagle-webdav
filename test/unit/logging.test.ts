import assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { ConfigStore } from '../../src/config/config';
import { DavRouter } from '../../src/dav/router';
import { FakeEagleAdapter } from '../../src/eagle/fakeAdapter';
import { argShape, instrumentAdapter } from '../../src/eagle/instrumented';
import { DavServer } from '../../src/http/server';
import { LibraryIndex } from '../../src/index/libraryIndex';
import { buildDiagnostics } from '../../src/util/diagnostics';
import { FileLog } from '../../src/util/fileLog';
import { RingLogger } from '../../src/util/log';
import { Metrics } from '../../src/util/metrics';
import { newCtx, runWithCtx } from '../../src/util/reqctx';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ewdav-log-'));
const read = (dir: string) => fs.readdirSync(dir).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');

test('FileLog：按天分文件、每行一条 JSON', () => {
  const dir = tmp();
  let day = new Date(2026, 9, 12, 10, 0, 0);
  const log = new FileLog({ dir, now: () => day });
  log.write({ a: 1 });
  log.write({ a: 2 });
  log.flush();
  day = new Date(2026, 9, 13, 0, 5, 0);
  log.write({ a: 3 });
  log.flush();
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['webdav-2026-10-12.log', 'webdav-2026-10-13.log']);
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'webdav-2026-10-12.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).a), [1, 2]);
});

test('FileLog：超过单文件上限就滚动，tail 跨文件按时间顺序', () => {
  const dir = tmp();
  const log = new FileLog({ dir, maxBytes: 200, now: () => new Date(2026, 9, 12) });
  for (let i = 0; i < 12; i++) { log.write({ i, pad: 'x'.repeat(40) }); log.flush(); }
  const names = fs.readdirSync(dir).sort();
  assert.ok(names.length >= 3, names.join());
  assert.ok(names.includes('webdav-2026-10-12.1.log'));
  for (const n of names) assert.ok(fs.statSync(path.join(dir, n)).size <= 300);
  assert.deepStrictEqual(log.tail(5).map((l) => JSON.parse(l).i), [7, 8, 9, 10, 11]);
});

test('FileLog：清理超过保留天数的文件与超出总量的旧文件', () => {
  const dir = tmp();
  for (const d of ['2026-10-01', '2026-10-05', '2026-10-06', '2026-10-12']) fs.writeFileSync(path.join(dir, `webdav-${d}.log`), 'x'.repeat(100));
  const log = new FileLog({ dir, keepDays: 7, now: () => new Date(2026, 9, 12) });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['webdav-2026-10-06.log', 'webdav-2026-10-12.log']);
  const log2 = new FileLog({ dir, keepDays: 7, totalBytes: 150, now: () => new Date(2026, 9, 12) });
  log2.write({ k: 1 }); log2.flush();
  assert.ok(fs.readdirSync(dir).includes('webdav-2026-10-12.log'));
  assert.ok(!fs.readdirSync(dir).includes('webdav-2026-10-06.log'));
  void log;
});

test('RingLogger：级别过滤，请求内自动带 rid', () => {
  const recs: any[] = [];
  const lg = new RingLogger();
  lg.file = { write: (r) => recs.push(r) };
  lg.log('debug', 'x', 'hidden');
  lg.log('info', 'x', 'shown', { a: 1 });
  const ctx = newCtx();
  runWithCtx(ctx, () => lg.log('warn', 'x', 'inreq'));
  lg.level = 'debug';
  lg.log('debug', 'x', 'now-shown');
  assert.deepStrictEqual(recs.map((r) => r.ev), ['shown', 'inreq', 'now-shown']);
  assert.strictEqual(recs[1].rid, ctx.rid);
  assert.strictEqual(recs[0].rid, undefined);
  assert.ok(lg.messages().some((m) => m.includes('x.shown')));
});

test('Metrics：p50 / p95、请求计数、缓存命中率按两次快照之间计算', () => {
  let t = 1_000_000;
  const m = new Metrics(() => t);
  for (let i = 1; i <= 100; i++) { m.begin(); t += 10; m.end(i % 2 ? 'GET' : 'PROPFIND', i); }
  const s = m.takeSnapshot(60_000, { hit: 9, miss: 1 });
  assert.strictEqual(s.total, 100);
  assert.deepStrictEqual(s.req, { GET: 50, PROPFIND: 50 });
  assert.strictEqual(s.p50, 50);
  assert.strictEqual(s.p95, 95);
  assert.strictEqual(s.cacheHit, 0.9);
  m.begin(); t += 5; m.end('GET', 5);
  assert.strictEqual(m.takeSnapshot(60_000, { hit: 9, miss: 1 }).cacheHit, null);
  t += 6 * 60_000;
  assert.strictEqual(m.summary(5 * 60_000).total, 0);
});

test('instrumentAdapter：累计到请求、慢调用与报错写日志且不带参数内容', async () => {
  const recs: any[] = [];
  const lg = new RingLogger();
  lg.level = 'debug';
  lg.file = { write: (r) => recs.push(r) };
  const fake = new FakeEagleAdapter();
  const folder = fake.addFolder('机密文件夹名');
  const wrapped = instrumentAdapter(fake, lg, 0);
  const ctx = newCtx();
  await runWithCtx(ctx, async () => { await wrapped.getFolders(); await wrapped.getItems(folder.id); });
  assert.strictEqual(ctx.eagleCalls, 2);
  assert.ok(recs.some((r) => r.ev === 'slow' && r.fn === 'getFolders' && r.n === 1 && r.rid === ctx.rid));
  fake.getItemFile = async () => { throw new Error('boom'); };
  await assert.rejects(() => wrapped.getItemFile('SECRET-ID'), /boom/);
  const err = recs.find((r) => r.ev === 'error');
  assert.strictEqual(err.fn, 'getItemFile');
  assert.strictEqual(err.args, 'str');
  assert.ok(!JSON.stringify(recs).includes('SECRET-ID'));
  assert.strictEqual(argShape(['a', ['x', 'y'], { name: 1, tags: 2 }, 3]), 'str,arr2,{name,tags},3');
  assert.strictEqual(wrapped.appInfo().build, fake.appInfo().build);
});

// ---- 服务端集成 ----
let PORT = 0;
const dir = tmp();
const store = new ConfigStore(dir);
store.load();
store.update({ host: '127.0.0.1', port: 0, username: 'u' });
store.setPassword('s3cret-pass');
const recs: any[] = [];
const logger = new RingLogger();
logger.level = 'debug';
logger.file = { write: (r) => recs.push(r) };
const fake = new FakeEagleAdapter();
const F = fake.addFolder('图');
fake.addItem('old', 'png', 'OLD', [F.id]);
const adapter = instrumentAdapter(fake, logger);
const index = new LibraryIndex(adapter);
index.logger = logger;
const router = new DavRouter(adapter, index, logger, { tmpRoot: path.join(dir, 'put') });
const metrics = new Metrics();
const server = new DavServer({ getConfig: () => store.get(), logger, metrics, handler: (x, y) => router.handle(x, y) });
const AUTH = { Authorization: 'Basic ' + Buffer.from('u:s3cret-pass').toString('base64') };
function req(method: string, p: string, headers: http.OutgoingHttpHeaders = {}, body?: string) {
  return new Promise<number>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: encodeURI(p), headers: { ...AUTH, 'User-Agent': 'Infuse/7', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => setTimeout(() => resolve(res.statusCode!), 20));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test('服务端：启动、写操作、拒绝、新客户端都有结构化日志', async () => {
  await server.start();
  PORT = server.listenInfo!.port;
  assert.ok(recs.some((r) => r.cat === 'svc' && r.ev === 'listen'));
  assert.strictEqual(await req('PUT', '/图/new.png', {}, 'NEW'), 201);
  const put = recs.find((r) => r.ev === 'put.create');
  assert.ok(put, JSON.stringify(recs.map((r) => r.ev)));
  assert.strictEqual(put.path, '/图/new.png');
  assert.strictEqual(put.status, 201);
  assert.ok(put.rid && put.rid.length === 6);
  assert.ok(put.eagleCalls > 0);
  assert.strictEqual(put.client, 'Infuse');
  assert.strictEqual(recs.filter((r) => r.cat === 'cli' && r.ev === 'new').length, 1);
  assert.strictEqual(await req('PUT', '/图/new.png', {}, 'NEW2'), 204);
  assert.ok(recs.some((r) => r.ev === 'put.replace'));
  // 系统文件只进暂存区：不记 info 的 put.create，只有 debug 的 put.shadow
  const before = recs.filter((r) => r.ev === 'put.create').length;
  assert.strictEqual(await req('PUT', '/图/.DS_Store', {}, 'x'), 201);
  assert.strictEqual(recs.filter((r) => r.ev === 'put.create').length, before);
  assert.ok(recs.some((r) => r.ev === 'put.shadow' && r.level === 'debug' && r.shadow === undefined));
  assert.strictEqual(await req('PUT', '/图/noext', {}, 'x'), 415);
  assert.ok(recs.some((r) => r.cat === 'req' && r.ev === 'deny' && r.status === 415));
  // 同一请求里的 eagle.call 日志与该请求的 rid 一致
  const rid = put.rid;
  assert.ok(recs.some((r) => r.cat === 'eagle' && r.rid === rid));
  assert.ok(metrics.summary(60_000).total >= 3);
});

test('服务端：认证失败记来源和次数，但不含尝试的密码', async () => {
  const bad = await new Promise<number>((resolve) => {
    http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: '/', headers: { Authorization: 'Basic ' + Buffer.from('u:guess-123').toString('base64') } }, (res) => { res.resume(); resolve(res.statusCode!); }).end();
  });
  assert.strictEqual(bad, 401);
  const fail = recs.find((r) => r.cat === 'auth' && r.ev === 'fail');
  assert.ok(fail && fail.count === 1 && fail.ip);
  const all = JSON.stringify(recs);
  assert.ok(!all.includes('guess-123') && !all.includes('s3cret-pass'));
});

test('服务端：处理异常记 req.error 并带堆栈，慢请求记 req.slow', async () => {
  const orig = fake.getFolders.bind(fake);
  fake.getFolders = async () => { throw new Error('folders blew up'); };
  index.invalidate();
  assert.strictEqual(await req('GET', '/图/old.png'), 500);
  const e = recs.find((r) => r.cat === 'req' && r.ev === 'error');
  assert.ok(e && e.err === 'folders blew up' && Array.isArray(e.stack) && e.stack.length > 0);
  assert.strictEqual(recs.filter((r) => r.ev === 'error' && r.cat === 'req').length, 1, '同一个 500 不应记两遍');
  fake.getFolders = async () => { await new Promise((r) => setTimeout(r, 1100)); return orig(); };
  index.invalidate();
  assert.strictEqual(await req('PROPFIND', '/', { Depth: '1' }), 207);
  const slow = recs.find((r) => r.ev === 'slow' && r.cat === 'req');
  assert.ok(slow && slow.ms >= 1000 && slow.eagleMs >= 1000 && slow.items >= 1, JSON.stringify(slow));
  fake.getFolders = orig;
});

test('停止', async () => { await server.stop(); });

test('buildDiagnostics：抹掉路径，不含密码与账号', () => {
  const text = buildDiagnostics({
    pluginVersion: '1.0.0', eagleVersion: '4.0.0', build: 23, os: 'darwin 27', node: '16.17.1',
    libraryName: 'Production', folderCount: 12, listen: '0.0.0.0:41600', hasPassword: true,
    bonjour: true, preventSleep: true, tagsView: true, allView: true, logLevel: 'info',
    perf: { windowSec: 300, req: { GET: 4, PUT: 1 }, total: 5, p50: 30, p95: 600, cacheHit: null, heapMB: 100, inflightMax: 2 },
    cache: { hit: 9, miss: 1 },
    logLines: ['{"msg":"配置目录 /Users/me/Library/Eagle/eagle-webdav"}', '{"path":"/Volumes/Lib/Production.library/images"}'],
    redact: [['/Volumes/Lib/Production.library', '<资源库>'], ['/Users/me', '~']],
    now: new Date(2026, 9, 12, 14, 5)
  });
  assert.ok(text.startsWith('== WebDAV 共享 诊断信息（2026-10-12 14:05）=='));
  assert.ok(text.includes('认证：已设置'));
  assert.ok(text.includes('请求 5（GET 4 · PUT 1）· p50 30 ms · p95 600 ms · 缓存命中 90%'));
  assert.ok(text.includes('~/Library/Eagle') && text.includes('<资源库>/images'));
  assert.ok(!text.includes('/Users/me') && !text.includes('/Volumes/Lib'));
  assert.ok(text.includes('-- 最近 2 行日志（info 及以上）--'));
});

test('配置：logLevel 只接受四个级别', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ logLevel: 'debug' }));
  assert.strictEqual(new ConfigStore(d).load().logLevel, 'debug');
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ logLevel: 'trace' }));
  assert.strictEqual(new ConfigStore(d).load().logLevel, 'info');
});
