import type { ItemInfo } from '../eagle/adapter';
import type { DeadProp } from './context';
import { mimeOfExt } from '../util/mime';
import type { Entry } from '../vfs/naming';
import type { ShadowEntry } from '../vfs/shadow';
import type { Resolved } from '../vfs/resolver';
import { activeLockXml, SUPPORTED_LOCK_XML, type LockManager } from './locks';
import { escXml, hrefOf } from './path';
import type { PropfindRequest } from './xml';

export interface DavResource {
  segs: string[];
  isDir: boolean;
  size: number;
  mime: string;
  modified: number;
  created: number;
  etag: string | null;
  /** 条目的 Eagle 扩展属性来源。 */
  item?: ItemInfo;
}

/** Eagle 的时间戳按毫秒；小于 1e11 的当作秒。 */
function toMs(t: number): number {
  if (!t) return 0;
  return t < 1e11 ? t * 1000 : t;
}

export function etagOf(it: Pick<ItemInfo, 'id' | 'modifiedAt' | 'size'>): string {
  return `"${it.id}-${it.modifiedAt}-${it.size}"`;
}

function itemResource(segs: string[], it: ItemInfo, fallback: number): DavResource {
  return {
    segs, isDir: false, size: it.size, mime: mimeOfExt(it.ext),
    modified: toMs(it.modifiedAt) || fallback, created: toMs(it.importedAt) || toMs(it.modifiedAt) || fallback,
    etag: etagOf(it),
    item: it
  };
}

function shadowResource(segs: string[], e: ShadowEntry): DavResource {
  return {
    segs, isDir: e.isDir, size: e.size, mime: e.isDir ? 'httpd/unix-directory' : mimeOfExt(e.name.slice(e.name.lastIndexOf('.') + 1)),
    modified: e.modified, created: e.created, etag: e.isDir ? null : `"shadow-${e.modified}-${e.size}"`
  };
}

export function resourceOfResolved(r: Resolved, fallback: number): DavResource {
  if (r.kind === 'shadow') return shadowResource(r.segs, r.entry);
  if (r.kind === 'item') return itemResource(r.segs, r.item, fallback);
  const created = r.kind === 'folder' ? toMs(r.folder.createdAt) || fallback : fallback;
  return { segs: r.segs, isDir: true, size: 0, mime: 'httpd/unix-directory', modified: created, created, etag: null };
}

export function resourceOfEntry(parentSegs: string[], e: Entry, fallback: number): DavResource {
  const segs = [...parentSegs, e.name];
  if (e.shadow) return shadowResource(segs, e.shadow);
  if (e.item) return itemResource(segs, e.item, fallback);
  const created = toMs(e.folder?.createdAt ?? 0) || fallback;
  return { segs, isDir: true, size: 0, mime: 'httpd/unix-directory', modified: created, created, etag: null };
}

/** 创建时间：RFC 3339，UTC，不带毫秒（与 Go webdav 对齐）。 */
function iso(ms: number): string { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

const ALL_PROPS = ['resourcetype', 'getcontentlength', 'getcontenttype', 'getlastmodified', 'creationdate', 'getetag', 'displayname', 'supportedlock', 'lockdiscovery'];

function displayName(r: DavResource): string {
  return r.segs.length ? r.segs[r.segs.length - 1] : '';
}

function propValue(name: string, r: DavResource, locks: LockManager): string | null {
  switch (name) {
    case 'resourcetype': return r.isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
    case 'getcontentlength': return r.isDir ? null : `<D:getcontentlength>${r.size}</D:getcontentlength>`;
    case 'getcontenttype': return r.isDir ? null : `<D:getcontenttype>${escXml(r.mime)}</D:getcontenttype>`;
    case 'getlastmodified': return `<D:getlastmodified>${new Date(r.modified).toUTCString()}</D:getlastmodified>`;
    case 'creationdate': return `<D:creationdate>${iso(r.created)}</D:creationdate>`;
    case 'getetag': return r.etag ? `<D:getetag>${escXml(r.etag)}</D:getetag>` : null;
    case 'displayname': return `<D:displayname>${escXml(displayName(r))}</D:displayname>`;
    case 'supportedlock': return SUPPORTED_LOCK_XML;
    case 'lockdiscovery': return `<D:lockdiscovery>${locks.covering(r.segs).map(activeLockXml).join('')}</D:lockdiscovery>`;
  }
  return null;
}

const EAGLE_NS = 'urn:eagle-webdav:ns';

function eagleProp(name: string, r: DavResource): string | null {
  const it = r.item;
  if (!it) return null;
  const wrap = (v: string) => `<E:${name} xmlns:E="${EAGLE_NS}">${escXml(v)}</E:${name}>`;
  switch (name) {
    case 'id': return wrap(it.id);
    case 'tags': return wrap(JSON.stringify(it.tags));
    case 'folders': return wrap(JSON.stringify(it.folders));
    case 'width': return it.width ? wrap(String(it.width)) : null;
    case 'height': return it.height ? wrap(String(it.height)) : null;
    case 'star': return wrap(String(it.star));
    case 'annotation': return wrap(it.annotation);
    case 'url': return wrap(it.url);
  }
  return null;
}

export function responseXml(r: DavResource, req: PropfindRequest, locks: LockManager, dead?: Map<string, DeadProp>): string {
  const ok: string[] = [];
  const missing: string[] = [];
  if (req.mode === 'propname') {
    for (const k of ALL_PROPS) if (propValue(k, r, locks) !== null) ok.push(`<D:${k}/>`);
  } else if (req.mode === 'allprop') {
    for (const k of ALL_PROPS) { const v = propValue(k, r, locks); if (v !== null) ok.push(v); }
  } else {
    for (const w of req.props) {
      let v: string | null = null;
      if (w.ns === 'DAV:') v = propValue(w.name, r, locks);
      else if (w.ns === EAGLE_NS) v = eagleProp(w.name, r);
      else if (w.ns && dead?.has(`${w.ns}|${w.name}`)) {
        const d = dead.get(`${w.ns}|${w.name}`) as DeadProp;
        v = `<ns0:${w.name} xmlns:ns0="${escXml(d.ns)}">${d.value}</ns0:${w.name}>`;
      }
      if (v !== null) ok.push(v);
      else if (w.ns && w.ns !== 'DAV:') missing.push(`<ns0:${w.name} xmlns:ns0="${escXml(w.ns)}"/>`);
      else if (w.ns === 'DAV:') missing.push(`<D:${w.name}/>`);
      else missing.push(`<${w.prefix ? w.prefix + ':' : ''}${w.name}/>`);
    }
  }
  let x = `<D:response><D:href>${escXml(hrefOf(r.segs, r.isDir))}</D:href>`;
  if (ok.length) x += `<D:propstat><D:prop>${ok.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`;
  if (missing.length) x += `<D:propstat><D:prop>${missing.join('')}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`;
  if (!ok.length && !missing.length) x += '<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat>';
  return x + '</D:response>';
}
