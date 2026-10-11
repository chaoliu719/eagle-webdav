export interface ParsedPath {
  segs: string[];
  trailingSlash: boolean;
}

/** 解析请求 URL 为路径段：逐段百分号解码，拒绝含 "/"、NUL、"."、".." 的段，逐段 NFC。 */
export function parseRequestPath(raw: string): ParsedPath | null {
  let p = String(raw || '');
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  const abs = /^https?:\/\/[^/]*(\/.*)?$/i.exec(p);
  if (abs) p = abs[1] || '/';
  if (p.charAt(0) !== '/') return null;
  const segs: string[] = [];
  for (const raw of p.split('/').slice(1)) {
    if (raw === '') continue;
    let s: string;
    try { s = decodeURIComponent(raw); } catch { return null; }
    if (s === '.' || s === '..' || s.includes('/') || s.includes('\0')) return null;
    segs.push(s.normalize('NFC'));
  }
  return { segs, trailingSlash: p.endsWith('/') };
}

export function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 统一的 href：以 / 开头、逐段 UTF-8 百分号编码，集合以 / 结尾。 */
export function hrefOf(segs: string[], isDir: boolean): string {
  if (!segs.length) return '/';
  return '/' + segs.map(encodeURIComponent).join('/') + (isDir ? '/' : '');
}
