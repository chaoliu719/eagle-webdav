import * as fs from 'fs';
import type * as http from 'http';
import type { EagleAdapter } from '../eagle/adapter';
import { readBody, send, sendXml } from '../http/respond';
import type { LibraryIndex } from '../index/libraryIndex';
import type { Logger } from '../util/log';
import { Resolver, type Resolved } from '../vfs/resolver';
import { evaluate, ifRangeAllows, parseRange } from './conditional';
import { activeLockXml, LockManager } from './locks';
import { escXml, hrefOf, parseRequestPath } from './path';
import { etagOf, resourceOfEntry, resourceOfResolved, responseXml } from './props';
import { hasDoctype, parsePropfind } from './xml';
import { safeLibraryFile } from './safeFile';

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
  private resolver: Resolver;

  constructor(private adapter: EagleAdapter, private index: LibraryIndex, private logger: Logger) {
    this.resolver = new Resolver(index);
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = parseRequestPath(req.url ?? '');
    if (!parsed) { req.resume(); return send(res, 400, {}, 'Bad path'); }
    const method = req.method ?? '';
    switch (method) {
      case 'OPTIONS': return this.options(req, res, parsed.segs);
      case 'PROPFIND': return this.propfind(req, res, parsed.segs);
      case 'GET':
      case 'HEAD': return this.get(req, res, parsed.segs);
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
    const allow = !r ? ALLOW_MISSING : r.kind === 'item' ? ALLOW_FILE : ALLOW_DIR;
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
    await write(res, responseXml(resourceOfResolved(r, fallback), request, this.locks));
    if (depth === '1' && r.kind !== 'item') {
      const entries = await this.resolver.children(r);
      if (entries.length > WARN_ENTRIES) this.logger.warn(`目录条目过多：${hrefOf(r.segs, true)} 共 ${entries.length} 项`);
      let n = 0;
      for (const e of entries) {
        await write(res, responseXml(resourceOfEntry(r.segs, e, fallback), request, this.locks));
        if (++n % YIELD_EVERY === 0) await tick();
      }
    }
    res.end('</D:multistatus>');
  }

  private async get(req: http.IncomingMessage, res: http.ServerResponse, segs: string[]): Promise<void> {
    req.resume();
    const r = await this.resolver.resolve(segs);
    if (!r) return send(res, 404, {}, 'Not Found');
    if (r.kind !== 'item') return this.listing(res, r);

    // 每次都实时读取 filePath：改名会改变磁盘文件名
    const live = await this.adapter.getItemFile(r.item.id);
    if (!live) return send(res, 404, {}, 'Not Found');
    const file = await safeLibraryFile(await this.index.libraryPath(), live.filePath);
    if (!file) {
      this.logger.warn(`拒绝读取库外文件：${live.id}`);
      return send(res, 404, {}, 'Not Found');
    }
    const size = file.size;
    if (size !== live.size) this.index.invalidate();
    const etag = etagOf(live);
    const lastModified = live.modifiedAt < 1e11 ? live.modifiedAt * 1000 : live.modifiedAt;
    const headers: http.OutgoingHttpHeaders = {
      Server: 'EagleWebdav/0.1',
      'Content-Type': resourceOfResolved(r, 0).mime,
      ETag: etag,
      'Last-Modified': new Date(lastModified).toUTCString(),
      'Accept-Ranges': 'bytes'
    };

    const pre = evaluate(req.headers, { etag, lastModified });
    if (pre === 'precondition-failed') return send(res, 412, headers);
    if (pre === 'not-modified') return send(res, 304, headers);

    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = ifRangeAllows(req.headers, { etag, lastModified }) ? parseRange(req.headers['range'], size) : { kind: 'none' as const };
    if (range.kind === 'unsatisfiable') return send(res, 416, { ...headers, 'Content-Range': `bytes */${size}` });
    if (range.kind === 'range') {
      status = 206;
      start = range.start;
      end = range.end;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) return void res.end();

    const stream = fs.createReadStream(file.realPath, { start, end });
    res.on('close', () => stream.destroy());
    stream.on('error', (e) => {
      this.logger.error(`读取文件失败：${e.message}`);
      res.destroy();
    });
    stream.pipe(res);
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

    const existing = this.locks.covering(segs);
    const held = String(req.headers['if'] ?? '');
    if (existing.some((l) => (l.scope === 'exclusive' || scope === 'exclusive') && !held.includes(l.token))) {
      return send(res, 423, {}, 'Locked');
    }
    const r = await this.resolver.resolve(segs);
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
