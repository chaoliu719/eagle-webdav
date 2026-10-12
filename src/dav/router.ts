import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as http from 'http';
import type { EagleAdapter } from '../eagle/adapter';
import { readBody, send, sendXml } from '../http/respond';
import type { LibraryIndex } from '../index/libraryIndex';
import type { Logger } from '../util/log';
import { KeyedMutex } from '../util/mutex';
import { ShadowStore } from '../vfs/shadow';
import { Resolver, isCollection, isTagsView, pathKey, type Resolved } from '../vfs/resolver';
import type { DavContext } from './context';
import { handleDelete } from './handlers/delete';
import { handleMkcol } from './handlers/mkcol';
import { handleProppatch } from './handlers/proppatch';
import { handlePut } from './handlers/put';
import { handleTransfer } from './handlers/transfer';
import { activeLockXml, LockManager } from './locks';
import { escXml, hrefOf, parseRequestPath } from './path';
import { etagOf, resourceOfEntry, resourceOfResolved, responseXml } from './props';
import { hasDoctype, parsePropfind } from './xml';
import { safeLibraryFile } from './safeFile';
import { serveFile } from './serve';

const MAX_XML_BODY = 1024 * 1024;
const YIELD_EVERY = 500;
const WARN_ENTRIES = 20000;

const ALLOW_MISSING = 'OPTIONS, LOCK, PUT, MKCOL';
// 与 Go net/http webdav 一致：集合不含 GET/HEAD（见 CLAUDE.md 的 Finder 卡顿修复）
const ALLOW_DIR = 'OPTIONS, LOCK, DELETE, PROPPATCH, COPY, MOVE, UNLOCK, PROPFIND';
const ALLOW_FILE = 'OPTIONS, LOCK, GET, HEAD, POST, DELETE, PROPPATCH, COPY, MOVE, UNLOCK, PROPFIND, PUT';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function write(res: http.ServerResponse, chunk: string): Promise<void> | void {
  if (!res.write(chunk)) return new Promise((r) => res.once('drain', () => r()));
}

export class DavRouter {
  readonly locks = new LockManager();
  readonly shadow: ShadowStore;
  private resolver: Resolver;
  private ctx: DavContext;

  constructor(
    private adapter: EagleAdapter, private index: LibraryIndex, private logger: Logger,
    opts: { maxPut?: number; tmpRoot?: string; shadowDir?: string; tagsView?: () => boolean } = {}
  ) {
    this.shadow = new ShadowStore(Date.now, opts.shadowDir);
    this.resolver = new Resolver(index, this.shadow, { tagsView: opts.tagsView });
    this.ctx = {
      adapter, index, resolver: this.resolver, locks: this.locks, shadow: this.shadow, logger, mutex: new KeyedMutex(),
      tmpRoot: opts.tmpRoot ?? path.join(os.tmpdir(), 'eagle-webdav', 'put'),
      maxPut: opts.maxPut ?? 4 * 1024 * 1024 * 1024,
      deadProps: new Map()
    };
  }

  /** 退出时清理临时文件。 */
  dispose(): void {
    this.shadow.clear();
    try { fs.rmSync(this.shadow.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(this.ctx.tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /** 资源库切换：清掉与旧库相关的锁、影子条目与 dead 属性。 */
  reset(): void {
    this.shadow.clear();
    this.ctx.deadProps.clear();
    this.index.invalidate();
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? '';
    const parsed = parseRequestPath(req.url ?? '');
    if (!parsed) { req.resume(); return send(res, 400, {}, 'Bad path'); }
    switch (method) {
      case 'OPTIONS': return this.options(req, res, parsed.segs);
      case 'PROPFIND': return this.propfind(req, res, parsed.segs);
      case 'GET':
      case 'HEAD': return this.get(req, res, parsed.segs);
      case 'PUT': return handlePut(this.ctx, req, res, parsed.segs);
      case 'MKCOL': return handleMkcol(this.ctx, req, res, parsed.segs);
      case 'DELETE': return handleDelete(this.ctx, req, res, parsed.segs);
      case 'MOVE': return handleTransfer(this.ctx, req, res, parsed.segs, true);
      case 'COPY': return handleTransfer(this.ctx, req, res, parsed.segs, false);
      case 'PROPPATCH': return handleProppatch(this.ctx, req, res, parsed.segs);
      case 'LOCK': return this.lock(req, res, parsed.segs);
      case 'UNLOCK': return this.unlock(req, res);
      default:
        req.resume();
        return send(res, 501, {}, 'Not Implemented');
    }
  }

  private async options(req: http.IncomingMessage, res: http.ServerResponse, segs: string[]): Promise<void> {
    req.resume();
    const r = await this.resolver.resolve(segs);
    const isFile = r && (r.kind === 'item' || (r.kind === 'shadow' && !r.entry.isDir));
    const allow = !r ? ALLOW_MISSING : isFile ? ALLOW_FILE : ALLOW_DIR;
    send(res, 200, { DAV: '1, 2', Allow: allow, 'MS-Author-Via': 'DAV' });
  }

  private async propfind(req: http.IncomingMessage, res: http.ServerResponse, segs: string[]): Promise<void> {
    const body = (await readBody(req, MAX_XML_BODY)).toString('utf8');
    if (hasDoctype(body)) return send(res, 400, {}, 'DOCTYPE not allowed');
    const depth = req.headers['depth'];
    if (depth === undefined || depth === 'infinity') {
      return sendXml(res, 403, '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>');
    }
    if (depth !== '0' && depth !== '1') return send(res, 400, {}, 'Bad Depth');

    const r = await this.resolver.resolve(segs);
    if (!r) return send(res, 404, {}, 'Not Found');
    const request = parsePropfind(body);
    const fallback = await this.index.modificationTime();

    res.writeHead(207, { Server: 'EagleWebdav/0.1', 'Content-Type': 'text/xml; charset=utf-8' });
    await write(res, '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">');
    await write(res, responseXml(resourceOfResolved(r, fallback), request, this.locks, this.ctx.deadProps.get(pathKey(r.segs))));
    if (depth === '1' && r.kind !== 'item') {
      const entries = await this.resolver.children(r);
      if (entries.length > WARN_ENTRIES) this.logger.warn(`目录条目过多：${hrefOf(r.segs, true)} 共 ${entries.length} 项`);
      let n = 0;
      for (const e of entries) {
        await write(res, responseXml(resourceOfEntry(r.segs, e, fallback), request, this.locks, this.ctx.deadProps.get(pathKey([...r.segs, e.name]))));
        if (++n % YIELD_EVERY === 0) await tick();
      }
    }
    res.end('</D:multistatus>');
  }

  private async get(req: http.IncomingMessage, res: http.ServerResponse, segs: string[]): Promise<void> {
    req.resume();
    const r = await this.resolver.resolve(segs);
    if (!r) return send(res, 404, {}, 'Not Found');
    if (r.kind === 'shadow' && !r.entry.isDir) {
      const e = r.entry;
      if (!e.file) return serveFile(req, res, { realPath: '', size: 0, mime: resourceOfResolved(r, 0).mime, etag: `"shadow-${e.modified}-0"`, lastModified: e.modified }, this.logger);
      return serveFile(req, res, { realPath: e.file, size: e.size, mime: resourceOfResolved(r, 0).mime, etag: `"shadow-${e.modified}-${e.size}"`, lastModified: e.modified }, this.logger);
    }
    if (r.kind !== 'item') return this.listing(res, r);

    // 每次都实时读取 filePath：改名会改变磁盘文件名
    const raw = await this.adapter.getItemFile(r.item.id);
    if (!raw) return send(res, 404, {}, 'Not Found');
    const live = this.index.normalize(raw);
    const file = await safeLibraryFile(await this.index.libraryPath(), live.filePath);
    if (!file) {
      this.logger.warn(`拒绝读取库外文件：${live.id}`);
      return send(res, 404, {}, 'Not Found');
    }
    if (file.size !== live.size) this.index.invalidate();
    serveFile(req, res, {
      realPath: file.realPath, size: file.size, mime: resourceOfResolved(r, 0).mime, etag: etagOf(live),
      lastModified: live.modifiedAt < 1e11 ? live.modifiedAt * 1000 : live.modifiedAt
    }, this.logger);
  }

  private async listing(res: http.ServerResponse, r: Resolved): Promise<void> {
    const entries = await this.resolver.children(r);
    const li = entries.map((e) => {
      const d = e.kind !== 'item';
      return `<li><a href="${escXml(hrefOf([...r.segs, e.name], d))}">${escXml(e.name + (d ? '/' : ''))}</a></li>`;
    }).join('');
    const title = escXml(hrefOf(r.segs, true));
    send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' },
      `<!DOCTYPE html><meta charset="utf-8"><title>${title}</title><h3>${title}</h3><ul>${li}</ul>`);
  }

  // ---------- 假锁 ----------
  private async lock(req: http.IncomingMessage, res: http.ServerResponse, segs: string[]): Promise<void> {
    const body = (await readBody(req, MAX_XML_BODY)).toString('utf8');
    if (hasDoctype(body)) return send(res, 400, {}, 'DOCTYPE not allowed');
    const timeoutSec = parseTimeout(req.headers['timeout']);

    if (!body.trim()) {
      // 刷新：If 头里带着原 token
      const token = /opaquelocktoken:([0-9a-fA-F-]+)/.exec(String(req.headers['if'] ?? ''))?.[1];
      const l = token ? this.locks.refresh(token, timeoutSec) : null;
      if (!l) return send(res, 412, {}, 'Precondition Failed');
      return this.lockResponse(res, 200, l);
    }

    const scope = /<(?:[A-Za-z0-9_.-]+:)?shared[\s/>]/.test(body) ? 'shared' : 'exclusive';
    const owner = /<(?:[A-Za-z0-9_.-]+:)?owner(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?owner>/.exec(body)?.[1] ?? '';
    const depth = String(req.headers['depth'] ?? 'infinity') === '0' ? '0' : 'infinity';

    // 设计决定：永不拒绝加锁，已有锁时也发新令牌。真实 Finder 崩溃后会遗留 10 分钟的旧锁，
    // 若拒绝会让它在锁过期前一直无法写入。这是有意的非强制实现。
    const r = await this.resolver.resolve(segs);
    if (!r) {
      // 对不存在的 URL 加锁：在影子区建一个空占位（RFC 4918 的"锁定空资源"），父目录不存在返回 409
      if (segs.length === 0) return send(res, 409, {}, 'Conflict');
      const parent = await this.resolver.resolve(segs.slice(0, -1));
      if (!parent || !isCollection(parent)) return send(res, 409, {}, '父目录不存在');
      if (parent.kind === 'root' || isTagsView(parent)) return send(res, 403, {}, '这里不能创建文件');
      this.shadow.putFile(pathKey([...parent.segs, segs[segs.length - 1]]), segs[segs.length - 1], null, 0);
    }
    const lock = this.locks.create(segs, scope, depth, owner, timeoutSec);
    this.lockResponse(res, r ? 200 : 201, lock);
  }

  private lockResponse(res: http.ServerResponse, status: number, l: ReturnType<LockManager['create']>): void {
    sendXml(res, status,
      `<D:prop xmlns:D="DAV:"><D:lockdiscovery>${activeLockXml(l)}</D:lockdiscovery></D:prop>`,
      { 'Lock-Token': `<opaquelocktoken:${l.token}>` });
  }

  private unlock(req: http.IncomingMessage, res: http.ServerResponse): void {
    req.resume();
    const token = /opaquelocktoken:([0-9a-fA-F-]+)/.exec(String(req.headers['lock-token'] ?? ''))?.[1];
    if (!token) return send(res, 400, {}, 'Missing Lock-Token');
    if (!this.locks.remove(token)) return send(res, 409, {}, 'Not locked');
    send(res, 204);
  }
}

function parseTimeout(h: string | string[] | undefined): number {
  const m = /Second-(\d+)/i.exec(String(h ?? ''));
  const n = m ? Number(m[1]) : 600;
  return Math.min(Math.max(n, 1), 3600);
}
