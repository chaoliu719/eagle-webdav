import type { PerfSnapshot } from './metrics';

export interface DiagInput {
  pluginVersion: string;
  eagleVersion: string;
  build: number;
  os: string;
  node: string;
  libraryName: string | null;
  folderCount: number | null;
  /** 如 "0.0.0.0:41600（含 IPv6）"；未运行为 null。 */
  listen: string | null;
  hasPassword: boolean;
  bonjour: boolean;
  preventSleep: boolean;
  allView: boolean;
  logLevel: string;
  perf: PerfSnapshot | null;
  cache: { hit: number; miss: number } | null;
  logLines: string[];
  /** 需要从文本里抹掉的字符串（资源库路径、用户主目录等）及其替代写法。 */
  redact: Array<[string, string]>;
  now?: Date;
}

const yn = (b: boolean) => (b ? '开' : '关');

/**
 * 「复制诊断信息」的文本：版本、开关、最近的性能与日志。
 * 不含密码与哈希、账号名、认证头、文件内容；资源库路径和用户主目录会被替换。
 */
export function buildDiagnostics(i: DiagInput): string {
  const d = i.now ?? new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const lines: string[] = [];
  lines.push(`== WebDAV 共享 诊断信息（${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}）==`);
  lines.push(`插件 ${i.pluginVersion} · Eagle ${i.eagleVersion} Build ${i.build} · ${i.os} · Node ${i.node}`);
  lines.push(`资源库：${i.libraryName ?? '（未知）'}${i.folderCount !== null ? `（${i.folderCount} 个文件夹）` : ''}`);
  lines.push(`监听：${i.listen ?? '未运行'} · 认证：${i.hasPassword ? '已设置' : '无'} · 自动发现：${yn(i.bonjour)} · 防休眠：${yn(i.preventSleep)}`);
  lines.push(`视图：@全部 ${yn(i.allView)} · 日志级别：${i.logLevel}`);
  lines.push('-- 最近 5 分钟性能 --');
  if (i.perf && i.perf.total > 0) {
    const methods = Object.entries(i.perf.req).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(' · ');
    const cache = i.cache && i.cache.hit + i.cache.miss > 0 ? ` · 缓存命中 ${Math.round((i.cache.hit / (i.cache.hit + i.cache.miss)) * 100)}%` : '';
    lines.push(`请求 ${i.perf.total}（${methods}）· p50 ${i.perf.p50} ms · p95 ${i.perf.p95} ms${cache} · 堆 ${i.perf.heapMB} MB`);
  } else {
    lines.push('（最近没有请求）');
  }
  lines.push(`-- 最近 ${i.logLines.length} 行日志（info 及以上）--`);
  lines.push(...i.logLines);
  let text = lines.join('\n');
  for (const [from, to] of i.redact) if (from) text = text.split(from).join(to);
  return text;
}
