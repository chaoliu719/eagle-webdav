import * as http from 'http';
import type { Socket } from 'net';
import type { Config } from '../config/config';
import type { Logger } from '../util/log';
import { friendlyClient } from '../util/clients';
import type { Metrics } from '../util/metrics';
import { newCtx, runWithCtx, type ReqCtx } from '../util/reqctx';
import { isAllowedAddress } from './access';
import { Authenticator } from './auth';

export interface ServerDeps {
  getConfig(): Config;
  logger: Logger;
  /** 通过认证后的请求处理器（DAV 路由）。 */
  handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
  /** 请求开始 / 结束的回调（防休眠等用）。 */
  activity?: { begin(): void; end(): void };
  auth?: Authenticator;
  /** 请求耗时统计（性能快照用）。 */
  metrics?: Metrics;
}

export interface ListenInfo {
  host: string;
  port: number;
  ipv6: boolean;
}

/** 会读写文件内容的方法。 */
const TRANSFER_METHODS = new Set(['GET', 'PUT', 'COPY', 'MOVE']);

/** 会修改资源库的方法：成功时记 info 日志。 */
const WRITE_METHODS = new Set(['PUT', 'MKCOL', 'DELETE', 'MOVE', 'COPY']);
const SLOW_MS = 1000;
const BULK_BYTES = 1024 * 1024;

function pathOf(url: string | undefined): string {
  const raw = (url ?? '').split('?')[0];
  try { return decodeURIComponent(raw); } catch { return raw; }
}

const REALM = 'Eagle Library';
const SERVER_NAME = 'EagleWebdav/0.1';

/**
 * HTTP 层：源地址过滤 → Basic 认证 → 方法分发。
 * 方法处理交给 deps.handler（DavRouter）。
 */
export class DavServer {
  private servers: http.Server[] = [];
  private sockets = new Set<Socket>();
  private auth: Authenticator;
  private switching = false;
  private counter = 0;
  private info: ListenInfo | null = null;
  private seenClients = new Set<string>();
  private deniedAt = new Map<string, number>();

  constructor(private deps: ServerDeps) {
    this.auth = deps.auth ?? new Authenticator();
    this.auth.events = {
      fail: (ip, count) => deps.logger.log('warn', 'auth', 'fail', { ip, count }, `认证失败 ${ip}（第 ${count} 次）`),
      ban: (ip, minutes) => deps.logger.log('warn', 'auth', 'ban', { ip, minutes }, `已封禁 ${ip} ${minutes} 分钟`)
    };
  }

  get running(): boolean { return this.info !== null; }
  get listenInfo(): ListenInfo | null { return this.info; }

  /** 资源库切换期间所有请求返回 503。 */
  setSwitching(v: boolean): void { this.switching = v; }

  async start(): Promise<ListenInfo> {
    if (this.info) return this.info;
    const cfg = this.deps.getConfig();
    const primary = this.create();
    await new Promise<void>((resolve, reject) => {
      primary.once('error', reject);
      primary.listen(cfg.port, cfg.host, () => { primary.off('error', reject); resolve(); });
    });
    this.servers.push(primary);
    // 配置端口为 0（测试里用，由系统分配）时，取实际端口
    const port = (primary.address() as { port: number } | null)?.port ?? cfg.port;

    let ipv6 = false;
    if (cfg.host === '0.0.0.0') {
      // 客户端经 .local 解析时常走 IPv6，尽力补一个 v6 监听；失败不影响主服务
      const s6 = this.create();
      ipv6 = await new Promise<boolean>((resolve) => {
        s6.once('error', (e) => { this.deps.logger.warn('IPv6 监听失败：' + e.message); resolve(false); });
        s6.listen({ port, host: '::', ipv6Only: true }, () => resolve(true));
      });
      if (ipv6) this.servers.push(s6);
    }
    primary.on('error', (e) => this.deps.logger.log('error', 'svc', 'error', { err: e.message }, '服务错误：' + e.message));
    this.info = { host: cfg.host, port, ipv6 };
    this.deps.logger.log('info', 'svc', 'listen', { host: cfg.host, port, ipv6 }, `已监听 ${cfg.host}:${port}${ipv6 ? '（含 IPv6）' : ''}`);
    return this.info;
  }

  async stop(): Promise<void> {
    if (!this.info) return;
    this.info = null;
    const closing = this.servers.map((s) => new Promise<void>((r) => s.close(() => r())));
    this.servers = [];
    this.sockets.forEach((sk) => sk.destroy());
    await Promise.all(closing);
    this.deps.logger.log('info', 'svc', 'stop', {}, '服务已停止');
  }

  private create(): http.Server {
    const s = http.createServer((req, res) => this.handle(req, res, false));
    s.on('checkContinue', (req, res) => this.handle(req, res, true));
    s.on('connection', (sock) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
    });
    s.on('clientError', (_e, sock) => {
      try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
    });
    // 与 Go net/http webdav 对齐，避免 Finder 卡顿（见 CLAUDE.md）
    s.keepAliveTimeout = 0;
    s.requestTimeout = 0;
    s.headersTimeout = 30_000;
    return s;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, viaContinue: boolean): void {
    const ctx = newCtx();
    runWithCtx(ctx, () => this.handleCtx(req, res, viaContinue, ctx));
  }

  private logRequest(req: http.IncomingMessage, res: http.ServerResponse, status: number | 'aborted', ms: number, ip: string, ctx: ReqCtx): void {
    const log = this.deps.logger;
    const method = req.method ?? '';
    const path = pathOf(req.url);
    const client = friendlyClient(req.headers['user-agent']);
    const key = `${ip}|${client}`;
    if (!this.seenClients.has(key)) {
      if (this.seenClients.size > 500) this.seenClients.clear();
      this.seenClients.add(key);
      log.log('info', 'cli', 'new', { ip: ip.replace(/^::ffff:/, ''), client }, `新客户端 ${client}（${ip.replace(/^::ffff:/, '')}）`);
    }
    const reqBytes = Number(req.headers['content-length']) || 0;
    const resBytes = Number(res.getHeader('content-length')) || 0;
    const base = { method, path, status, ms, eagleMs: ctx.eagleMs, eagleCalls: ctx.eagleCalls, ...ctx.fields };
    if (status === 'aborted') {
      log.log('warn', 'req', 'abort', { method, path, ms, sent: res.socket?.bytesWritten, received: req.socket.bytesRead, length: resBytes || reqBytes || undefined, client });
      return;
    }
    const bytes = Math.max(reqBytes, resBytes);
    const bulk = (method === 'GET' || method === 'PUT') && bytes >= BULK_BYTES;
    const mbps = bulk && ms > 0 ? Math.round((bytes / 1048576 / (ms / 1000)) * 10) / 10 : undefined;
    if (status >= 500 && !ctx.errored) log.log('error', 'req', 'error', { ...base, ip, client });
    else if (ctx.fields.shadow && status < 400) {
      // 系统文件（.DS_Store、._*）与 Finder 的 0 字节占位只进暂存区，不是真正入库，降到 debug 免得刷屏
      const { shadow: _s, ...rest } = base as Record<string, unknown>;
      log.log('debug', 'req', 'put.shadow', { ...rest, client });
    } else if (WRITE_METHODS.has(method) && status < 400) {
      const ev = method === 'PUT' ? (status === 201 ? 'put.create' : 'put.replace') : method.toLowerCase();
      log.log('info', 'req', ev, { ...base, bytes: reqBytes || undefined, mbps, client }, `${ev} ${path} ${status} ${ms}ms`);
    } else if (status >= 400 && status !== 401) log.log('debug', 'req', 'deny', { ...base, client });
    else if (bulk) log.log('debug', 'req', 'xfer', { ...base, bytes, mbps, client });
    else log.log('debug', 'req', 'done', { ...base, client });
    if (!bulk && ms > SLOW_MS) log.log('warn', 'req', 'slow', { ...base, client }, `慢请求 ${method} ${path} ${ms}ms（Eagle ${ctx.eagleMs}ms）`);
  }

  private handleCtx(req: http.IncomingMessage, res: http.ServerResponse, viaContinue: boolean, ctx: ReqCtx): void {
    const cfg = this.deps.getConfig();
    const ip = req.socket.remoteAddress ?? '';
    if (!isAllowedAddress(ip)) {
      const last = this.deniedAt.get(ip) ?? 0;
      if (Date.now() - last > 60_000) {
        this.deniedAt.set(ip, Date.now());
        if (this.deniedAt.size > 200) this.deniedAt.clear();
        this.deps.logger.log('warn', 'auth', 'source-denied', { ip }, `拒绝来源 ${ip}`);
      }
      req.socket.destroy();
      return;
    }

    const n = ++this.counter;
    const started = Date.now();
    let done = false;
    // 只有真正在传文件的请求才算「在用」；浏览目录、心跳（PROPFIND / OPTIONS / LOCK 等）不阻止休眠，
    // 否则 Finder 挂着一个空闲的卷也会让 Mac 永远睡不着
    const tracked = TRANSFER_METHODS.has(req.method ?? '');
    if (tracked) this.deps.activity?.begin();
    this.deps.metrics?.begin();
    const record = (status: number | 'aborted') => {
      if (done) return;
      done = true;
      if (tracked) this.deps.activity?.end();
      const ms = Date.now() - started;
      this.deps.metrics?.end(req.method ?? '', ms);
      this.logRequest(req, res, status, ms, ip, ctx);
      this.deps.logger.request({
        n, t: new Date(started).toISOString(), ip, method: req.method ?? '', url: req.url ?? '',
        status, ms: Date.now() - started,
        ua: req.headers['user-agent'], depth: req.headers['depth'] as string | undefined,
        range: req.headers['range'] as string | undefined,
        contentRange: res.getHeader('content-range') as string | undefined,
        length: res.getHeader('content-length') === undefined ? undefined : String(res.getHeader('content-length'))
      });
    };
    res.on('finish', () => record(res.statusCode));
    res.on('close', () => record('aborted'));

    const verdict = this.auth.check(req.headers['authorization'], ip, cfg);
    if (verdict === 'banned') {
      req.resume();
      return this.send(res, 403, { Connection: 'close' }, 'Forbidden');
    }
    if (verdict === 'denied') {
      req.resume();
      return this.send(res, 401, {
        'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
        Connection: 'close'
      }, 'Unauthorized');
    }
    if (viaContinue) res.writeContinue();

    if (this.switching) {
      req.resume();
      return this.send(res, 503, { 'Retry-After': '5' }, 'Service Unavailable');
    }

    this.deps.handler(req, res).catch((err: Error) => {
      ctx.errored = true;
      this.deps.logger.log('error', 'req', 'error', {
        method: req.method, path: pathOf(req.url), ip, client: friendlyClient(req.headers['user-agent']),
        err: err.message, stack: (err.stack ?? '').split('\n').slice(1, 4).map((l) => l.trim())
      }, `处理 ${req.method} ${req.url} 失败：${err.message}`);
      if (!res.headersSent) this.send(res, 500, {}, 'Internal Server Error');
      else res.destroy();
    });
  }

  private send(res: http.ServerResponse, status: number, headers: http.OutgoingHttpHeaders = {}, body = ''): void {
    const buf = Buffer.from(body, 'utf8');
    const h: http.OutgoingHttpHeaders = { Server: SERVER_NAME, ...headers, 'Content-Length': buf.length };
    if (body && !h['Content-Type']) h['Content-Type'] = 'text/plain; charset=utf-8';
    res.writeHead(status, h);
    res.end(res.req.method === 'HEAD' ? undefined : buf);
  }
}
