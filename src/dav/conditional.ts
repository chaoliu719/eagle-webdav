import type * as http from 'http';

export interface Validators { etag: string; lastModified: number }

export type Preconditions = 'ok' | 'not-modified' | 'precondition-failed';

function etagList(header: string): string[] {
  return header.split(',').map((s) => s.trim()).filter(Boolean);
}

function weakStrip(tag: string): string { return tag.replace(/^W\//, ''); }

function matches(header: string, etag: string): boolean {
  const list = etagList(header);
  return list.includes('*') || list.some((t) => weakStrip(t) === weakStrip(etag));
}

function httpDate(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** RFC 7232 的求值顺序：If-Match → If-Unmodified-Since → If-None-Match → If-Modified-Since。 */
export function evaluate(h: http.IncomingHttpHeaders, v: Validators): Preconditions {
  const lm = Math.floor(v.lastModified / 1000) * 1000;
  const ifMatch = h['if-match'];
  if (ifMatch !== undefined) {
    if (!matches(ifMatch, v.etag)) return 'precondition-failed';
  } else {
    const ius = httpDate(h['if-unmodified-since']);
    if (ius !== null && lm > ius) return 'precondition-failed';
  }
  const inm = h['if-none-match'];
  if (inm !== undefined) {
    if (matches(inm, v.etag)) return 'not-modified';
  } else {
    const ims = httpDate(h['if-modified-since']);
    if (ims !== null && lm <= ims) return 'not-modified';
  }
  return 'ok';
}

/** If-Range：与 ETag 完全一致或与 Last-Modified 相等才继续按 Range 处理。 */
export function ifRangeAllows(h: http.IncomingHttpHeaders, v: Validators): boolean {
  const ir = String(h['if-range'] ?? '');
  if (!ir) return true;
  if (ir.startsWith('"') || ir.startsWith('W/')) return !ir.startsWith('W/') && ir === v.etag;
  const t = httpDate(ir);
  return t !== null && t === Math.floor(v.lastModified / 1000) * 1000;
}

export type RangeResult = { kind: 'none' } | { kind: 'unsatisfiable' } | { kind: 'range'; start: number; end: number };

/** 单区间；多区间退化为整个文件。 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return { kind: 'none' };
  let start: number;
  let end: number;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n === 0) return { kind: 'unsatisfiable' };
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (m[2] && Number(m[2]) < start) return { kind: 'none' };
  }
  if (size === 0 || start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}
