import assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { ConfigStore } from '../../src/config/config';
import { DavServer } from '../../src/http/server';
import { RingLogger } from '../../src/util/log';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewdav-'));
const store = new ConfigStore(dir);
store.load();
store.update({ host: '127.0.0.1', port: 41698, username: 'u' });
store.setPassword('p');
const logger = new RingLogger();
const server = new DavServer({ getConfig: () => store.get(), logger });

function req(method: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 41698, method, path: '/', headers }, (res) => {
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

test('非本机监听必须先有密码', async () => {
  const s = new DavServer({ getConfig: () => ({ ...store.get(), host: '0.0.0.0', passwordHash: null }), logger });
  await assert.rejects(s.start(), /密码/);
});

test('认证、OPTIONS、501、503', async () => {
  await server.start();
  let r = await req('OPTIONS');
  assert.strictEqual(r.status, 401);
  assert.match(String(r.headers['www-authenticate']), /^Basic realm=/);
  r = await req('OPTIONS', AUTH);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['dav'], '1, 2');
  r = await req('PROPFIND', AUTH);
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
