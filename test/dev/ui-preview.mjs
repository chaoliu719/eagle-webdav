// 在普通浏览器里预览插件窗口：加载真实的 plugin/index.html 与 plugin/js/plugin.js，
// 给 require('fs'|'os'|…) 和 eagle 打桩，不碰真实的 Eagle 与磁盘。
// 用法：node test/dev/ui-preview.mjs [端口]   然后打开 http://127.0.0.1:<端口>/ （?pw=1 模拟已设置密码）
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { extname, join } from 'path';

const port = Number(process.argv[2] || 41777);
const root = join(process.cwd(), 'plugin');

const stubs = `
(function () {
  const noop = () => undefined;
  class Emitter { constructor() { this.h = {}; } on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; } off() { return this; } once(e, f) { return this.on(e, f); } emit(e, ...a) { (this.h[e] || []).forEach((f) => f(...a)); } removeAllListeners() { return this; } }
  const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  // ?pw=1：模拟「已设置密码」的配置（哈希是假的，预览里不会真的做登录校验）
  const withPw = new URLSearchParams(location.search).get('pw') === '1';
  const fakeCfg = JSON.stringify({ host: '0.0.0.0', port: 41600, username: 'eagle', passwordHash: 'scrypt$16384$00$00', readonlyUsername: 'viewer', readonlyPasswordHash: 'scrypt$16384$00$00' });
  const fs = { mkdirSync: noop, appendFileSync: (p, d) => { (window.__logfile = window.__logfile || []).push(String(d)); }, readdirSync: () => [], statSync: () => ({ size: 0 }), existsSync: () => false, rmSync: noop, renameSync: noop, readFileSync: (p) => (withPw && /config\\.json$/.test(p) ? fakeCfg : enoent()), writeFileSync: (p, d) => { if (window.__failWrite) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } window.__saved = String(d); }, mkdirSync: noop, renameSync: noop, rmSync: noop, statSync: enoent, promises: new Proxy({}, { get: () => async () => undefined }) };
  const path = { join: (...p) => p.join('/').replace(/\\/+/g, '/'), dirname: (p) => p.split('/').slice(0, -1).join('/') || '/', basename: (p) => p.split('/').pop(), extname: (p) => { const m = /\\.[^./]+$/.exec(p); return m ? m[0] : ''; }, sep: '/' };
  const os = { release: () => '27.0.0', homedir: () => '/Users/preview', tmpdir: () => '/tmp', hostname: () => 'preview-mac.local', networkInterfaces: () => ({ en0: [{ family: 'IPv4', address: '192.168.0.103', internal: false }], lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }) };
  const crypto = { randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => ((Math.random() * 16) | 0).toString(16)), randomBytes: () => ({ toString: () => '00' }), scryptSync: () => ({ toString: () => '00' }), createHash: () => ({ update() { return this; }, digest: () => new Uint8Array(32) }), timingSafeEqual: () => true };
  window.__listens = [];
  const http = {
    createServer: (handler) => { window.__handler = handler; const s = new Emitter(); s.listen = (...a) => { const cb = a[a.length - 1]; const port = typeof a[0] === 'object' ? a[0].port : a[0]; if ((window.__busyPorts || []).includes(port)) { setTimeout(() => s.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })), 0); return; } s._port = port; window.__listens.push(a[0]); if (typeof cb === 'function') setTimeout(cb, 0); }; s.close = (cb) => cb && cb(); s.address = () => ({ address: '0.0.0.0', port: s._port }); return s; }
  };
  // 预览里模拟「某个客户端发来一个请求」：window.__fakeRequest('WebDAVFS/3.0', '127.0.0.1')
  window.__fakeRequest = (ua, ip, method = 'OPTIONS') => {
    const ev = {};
    const res = { statusCode: 200, headersSent: false, writeHead(c) { this.statusCode = c; this.headersSent = true; }, write() { return true; }, end() { (ev.finish || []).forEach((f) => f()); }, on(e, f) { (ev[e] = ev[e] || []).push(f); return this; }, once() { return this; }, getHeader() { return undefined; }, setHeader() {} };
    const req = { method, url: '/', headers: { 'user-agent': ua }, socket: { remoteAddress: ip, destroy() {} }, resume() {}, on() { return this; } };
    res.req = req;
    window.__handler(req, res);
  };
  const child = () => { const c = new Emitter(); c.kill = () => c.emit("exit"); c.unref = noop; (window.__children = window.__children || []).push(c); return c; };
  class ALS { run(c, fn) { this.s = c; return fn(); } getStore() { return this.s; } }
  const mods = { async_hooks: { AsyncLocalStorage: ALS }, fs, path, os, crypto, http, events: { EventEmitter: Emitter }, stream: { Transform: class {} }, 'stream/promises': { pipeline: async () => undefined },
    child_process: { spawn: (c, a) => { (window.__spawned = window.__spawned || []).push([c, ...a].join(' ')); return child(); }, spawnSync: noop } };
  window.require = (m) => { if (!(m in mods)) throw new Error('未打桩的模块：' + m); return mods[m]; };
  window.process = { platform: 'darwin', pid: 4242, versions: { node: '16.17.1' }, memoryUsage: () => ({ rss: 0, heapUsed: 100 * 1048576 }), on: noop };
  window.Buffer = { from: (s) => ({ toString: () => s }), alloc: () => ({}), byteLength: (s) => new Blob([s]).size };
})();
`;

createServer((req, res) => {
  const path0 = req.url.split('?')[0];
  const url = path0 === '/' ? '/index.html' : path0;
  if (url === '/__stubs.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(stubs); }
  try {
    let body = readFileSync(join(root, url));
    if (url === '/index.html') body = Buffer.from(body.toString().replace('<script src="js/plugin.js"></script>', '<script src="/__stubs.js"></script>\n<script src="js/plugin.js"></script>'));
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': types[extname(url)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`预览：http://127.0.0.1:${port}/`));
