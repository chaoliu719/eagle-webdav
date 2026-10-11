/** 源地址过滤：默认只放行回环、RFC 1918 私有地址与链路本地地址。 */

function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let v = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    v = v * 256 + o;
  }
  return v;
}

export interface Cidr { base: number; mask: number }

export function parseCidr(s: string): Cidr | null {
  const [addr, bitsStr] = s.trim().split('/');
  const base = parseIPv4(addr);
  if (base === null) return null;
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

const DEFAULT_V4 = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']
  .map((c) => parseCidr(c) as Cidr);

function inAny(ip: number, list: Cidr[]): boolean {
  return list.some((c) => ((ip & c.mask) >>> 0) === c.base);
}

export function isAllowedAddress(remote: string | undefined, extra: string[] = []): boolean {
  if (!remote) return false;
  let addr = remote.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) addr = mapped[1];

  const v4 = parseIPv4(addr);
  if (v4 !== null) {
    if (inAny(v4, DEFAULT_V4)) return true;
    const extras = extra.map(parseCidr).filter((c): c is Cidr => c !== null);
    return inAny(v4, extras);
  }
  // IPv6：回环、链路本地 fe80::/10、唯一本地 fc00::/7
  if (addr === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true;
  return false;
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
