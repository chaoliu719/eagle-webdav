import * as http from 'http';
import type { Socket } from 'net';
import type { Config } from '../config/config';
import type { Logger } from '../util/log';
import { isAllowedAddress, isLoopbackHost } from './access';
import { Authenticator, type Role } from './auth';

export interface ServerDeps {
  getConfig(): Config;
  logger: Logger;
  /** 通过认证后的请求处理器（DAV 路由）。 */
  handler(req: http.IncomingMessage, res: http.ServerResponse, role: Role): Promise<void>;
  /** 请求开始 / 结束的回调（防休眠等用）。 */
  activity?: { begin(): void; end(): void };
  auth?: Authenticator;
}

export interface ListenInfo {
  host: string;
  port: number;
  ipv6: boolean;
}

const REALM = 'Eagle WebDAV';
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

  constructor(private deps: ServerDeps) {
    this.auth = deps.auth ?? new Authenticator();
  }

  get running(): boolean { return this.info !== null; }
  get listenInfo(): ListenInfo | null { return this.info; }

  /** 资源库切换期间所有请求返回 503。 */
  setSwitching(v: boolean): void { this.switching = v; }

  async start(): Promise<ListenInfo> {
    if (this.info) return this.info;
    const cfg = this.deps.getConfig();
    if (!isLoopbackHost(cfg.host) && !cfg.passwordHash) {
      throw new Error('监听非本机地址前必须先设置密码');
    }
    const primary = this.create();
    await new Promise<void>((resolve, reject) => {
      primary.once('error', reject);
      primary.listen(cfg.port, cfg.host, () => { primary.off('error', reject); resolve(); });
    });
    this.servers.push(primary);

    let ipv6 = false;
    if (cfg.host === '0.0.0.0') {
      // 客户端经 .local 解析时常走 IPv6，尽力补一个 v6 监听；失败不影响主服务
      const s6 = this.create();
      ipv6 = await new Promise<boolean>((resolve) => {
        s6.once('error', (e) => { this.deps.logger.warn('IPv6 监听失败：' + e.message); resolve(false); });
        s6.listen({ port: cfg.port, host: '::', ipv6Only: true }, () => resolve(true));
      });
      if (ipv6) this.servers.push(s6);
    }
    primary.on('error', (e) => this.deps.logger.error('服务错误：' + e.message));
    this.info = { host: cfg.host, port: cfg.port, ipv6 };
    this.deps.logger.info(`已监听 ${cfg.host}:${cfg.port}${ipv6 ? '（含 IPv6）' : ''}`);
    return this.info;
  }

  async stop(): Promise<void> {
    if (!this.info) return;
    this.info = null;
    const closing = this.servers.map((s) => new Promise<void>((r) => s.close(() => r())));
    this.servers = [];
    this.sockets.forEach((sk) => sk.destroy());
    await Promise.all(closing);
    this.deps.logger.info('服务已停止');
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
    const cfg = this.deps.getConfig();
    const ip = req.socket.remoteAddress ?? '';
    if (!isAllowedAddress(ip, cfg.extraAllowedCidrs)) {
      this.deps.logger.warn(`拒绝来源 ${ip}`);
      req.socket.destroy();
      return;
    }

    const n = ++this.counter;
    const started = Date.now();
    let done = false;
    let role: Role | undefined;
    this.deps.activity?.begin();
    const record = (status: number | 'aborted') => {
      if (done) return;
      done = true;
      this.deps.activity?.end();
      this.deps.logger.request({
        n, t: new Date(started).toISOString(), ip, method: req.method ?? '', url: req.url ?? '',
        status, ms: Date.now() - started,
        ua: req.headers['user-agent'], depth: req.headers['depth'] as string | undefined, role
      });
    };
    res.on('finish', () => record(res.statusCode));
    res.on('close', () => record('aborted'));

    const login = this.auth.login(req.headers['authorization'], ip, cfg);
    const verdict = login.result;
    role = login.role;
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

    this.deps.handler(req, res, role as Role).catch((err: Error) => {
      this.deps.logger.error(`处理 ${req.method} ${req.url} 失败：${err.message}`);
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
