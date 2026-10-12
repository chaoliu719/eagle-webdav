export interface PerfSnapshot {
  windowSec: number;
  req: Record<string, number>;
  total: number;
  p50: number;
  p95: number;
  cacheHit: number | null;
  heapMB: number;
  inflightMax: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

const KEEP_MS = 5 * 60_000;
const MAX_SAMPLES = 20_000;

/**
 * 请求耗时的内存统计：保留最近 5 分钟的样本，给每 60 秒的性能快照和诊断信息用。
 * 缓存命中率由外部提供累计计数，这里算两次快照之间的增量。
 */
export class Metrics {
  private samples: { t: number; method: string; ms: number }[] = [];
  private inflight = 0;
  private inflightMax = 0;
  private lastCache = { hit: 0, miss: 0 };

  constructor(private now: () => number = Date.now) {}

  begin(): void {
    this.inflight++;
    if (this.inflight > this.inflightMax) this.inflightMax = this.inflight;
  }

  end(method: string, ms: number): void {
    this.inflight = Math.max(0, this.inflight - 1);
    const t = this.now();
    this.samples.push({ t, method, ms });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    const cutoff = t - KEEP_MS;
    let i = 0;
    while (i < this.samples.length && this.samples[i].t < cutoff) i++;
    if (i) this.samples.splice(0, i);
  }

  /** 统计最近 windowMs 内的请求；cache 为索引的累计命中 / 未命中计数。 */
  summary(windowMs: number, cache?: { hit: number; miss: number }): PerfSnapshot {
    const since = this.now() - windowMs;
    const list = this.samples.filter((s) => s.t >= since);
    const req: Record<string, number> = {};
    for (const s of list) req[s.method] = (req[s.method] ?? 0) + 1;
    const ms = list.map((s) => s.ms).sort((a, b) => a - b);
    let cacheHit: number | null = null;
    if (cache) {
      const h = cache.hit - this.lastCache.hit;
      const m = cache.miss - this.lastCache.miss;
      cacheHit = h + m > 0 ? Math.round((h / (h + m)) * 100) / 100 : null;
    }
    return {
      windowSec: Math.round(windowMs / 1000), req, total: list.length,
      p50: percentile(ms, 0.5), p95: percentile(ms, 0.95), cacheHit,
      heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), inflightMax: this.inflightMax
    };
  }

  /** 取走一个时间窗的快照并重置「在途峰值」和缓存计数基线（每 60 秒调用）。 */
  takeSnapshot(windowMs: number, cache?: { hit: number; miss: number }): PerfSnapshot {
    const s = this.summary(windowMs, cache);
    this.inflightMax = this.inflight;
    if (cache) this.lastCache = { hit: cache.hit, miss: cache.miss };
    return s;
  }
}
