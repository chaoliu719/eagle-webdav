import type { RequestEntry } from './log';

/** 把 User-Agent 翻成人话。 */
export function friendlyClient(ua: string | undefined): string {
  const u = ua ?? '';
  if (/WebDAVFS|WebDAVLib/i.test(u)) return 'Finder';
  if (/Infuse/i.test(u)) return 'Infuse';
  if (/rclone/i.test(u)) return 'rclone';
  if (/Lavf|ffmpeg|ffprobe/i.test(u)) return 'ffmpeg';
  if (/curl/i.test(u)) return 'curl';
  if (/Cyberduck/i.test(u)) return 'Cyberduck';
  if (/Transmit/i.test(u)) return 'Transmit';
  if (/Documents|Readdle/i.test(u)) return 'Documents';
  if (/Mozilla/i.test(u)) return '浏览器';
  return u ? u.split(/[\s/]/)[0].slice(0, 24) : '未知客户端';
}

export interface ClientSummary {
  ip: string;
  client: string;
  requests: number;
  lastSeen: number;
}

/** 汇总最近 windowMs 内出现过的客户端（按 IP + 客户端类型）。 */
export function summarizeClients(entries: RequestEntry[], now: number, windowMs = 5 * 60_000): ClientSummary[] {
  const map = new Map<string, ClientSummary>();
  for (const e of entries) {
    const t = Date.parse(e.t) + e.ms;
    if (now - t > windowMs) continue;
    const client = friendlyClient(e.ua);
    const key = `${e.ip}|${client}`;
    const cur = map.get(key) ?? { ip: e.ip.replace(/^::ffff:/, ''), client, requests: 0, lastSeen: 0 };
    cur.requests++;
    cur.lastSeen = Math.max(cur.lastSeen, t);
    map.set(key, cur);
  }
  return Array.from(map.values()).sort((a, b) => b.lastSeen - a.lastSeen);
}
