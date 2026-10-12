import * as fs from 'fs';
import * as path from 'path';

export interface FileLogOptions {
  dir: string;
  /** 单个文件上限，超过则滚动到 webdav-日期.N.log。默认 5 MB。 */
  maxBytes?: number;
  /** 保留天数。默认 7。 */
  keepDays?: number;
  /** 所有日志文件总量上限，超过则从最旧的删起。默认 35 MB。 */
  totalBytes?: number;
  /** 批量写入间隔。默认 200 ms。 */
  flushMs?: number;
  now?: () => Date;
}

const NAME_RE = /^webdav-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

function dayOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 按天分文件的 JSON Lines 日志：批量写入、单文件封顶、按天数和总量清理。
 * 任何磁盘错误都只吞掉并计数，绝不影响服务。
 */
export class FileLog {
  private buf: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private day = '';
  private file = '';
  private size = 0;
  /** 写盘失败次数（测试与诊断用）。 */
  failures = 0;

  constructor(private opts: FileLogOptions) {
    try { fs.mkdirSync(opts.dir, { recursive: true }); } catch { this.failures++; }
    this.prune();
  }

  get dir(): string { return this.opts.dir; }
  private get now(): Date { return (this.opts.now ?? (() => new Date()))(); }

  write(rec: object): void {
    let line: string;
    try { line = JSON.stringify(rec); } catch { return; }
    this.buf.push(line);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.opts.flushMs ?? 200);
      this.timer.unref?.();
    }
  }

  /** 立即把缓冲写入磁盘。 */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.buf.length) return;
    const lines = this.buf;
    this.buf = [];
    try {
      this.open();
      const text = lines.join('\n') + '\n';
      const max = this.opts.maxBytes ?? 5 * 1024 * 1024;
      if (this.size > 0 && this.size + Buffer.byteLength(text) > max) this.roll();
      fs.appendFileSync(this.file, text);
      this.size += Buffer.byteLength(text);
    } catch { this.failures++; }
  }

  /** 选定当天的当前文件（跨天时切换，并顺带清理旧文件）。 */
  private open(): void {
    const d = this.now;
    const day = dayOf(d);
    if (day === this.day && this.file) return;
    this.day = day;
    this.file = path.join(this.opts.dir, `webdav-${day}.log`);
    try { this.size = fs.statSync(this.file).size; } catch { this.size = 0; }
    this.prune();
  }

  private roll(): void {
    let n = 1;
    while (fs.existsSync(path.join(this.opts.dir, `webdav-${this.day}.${n}.log`))) n++;
    fs.renameSync(this.file, path.join(this.opts.dir, `webdav-${this.day}.${n}.log`));
    this.size = 0;
    this.prune();
  }

  /** 日志文件，最新的在前。 */
  files(): string[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.opts.dir); } catch { return []; }
    return names
      .map((n) => ({ n, m: NAME_RE.exec(n) }))
      .filter((x): x is { n: string; m: RegExpExecArray } => !!x.m)
      // 先按日期，同一天里当前文件（无序号）最新，其余序号越大越新
      .map((x) => ({ n: x.n, day: x.m[1], seq: x.m[2] ? Number(x.m[2]) : Infinity }))
      .sort((a, b) => (a.day === b.day ? (b.seq > a.seq ? 1 : b.seq < a.seq ? -1 : 0) : a.day < b.day ? 1 : -1))
      .map((x) => path.join(this.opts.dir, x.n));
  }

  private prune(): void {
    try {
      const keep = this.opts.keepDays ?? 7;
      const cutoff = dayOf(new Date(this.now.getTime() - (keep - 1) * 86_400_000));
      let total = 0;
      const list = this.files();
      const sizes = new Map<string, number>();
      for (const f of list) {
        const day = NAME_RE.exec(path.basename(f))![1];
        if (day < cutoff) { fs.rmSync(f, { force: true }); continue; }
        const s = fs.statSync(f).size;
        sizes.set(f, s);
        total += s;
      }
      const cap = this.opts.totalBytes ?? 35 * 1024 * 1024;
      for (const f of Array.from(sizes.keys()).reverse()) {
        if (total <= cap || f === this.file) continue;
        total -= sizes.get(f)!;
        fs.rmSync(f, { force: true });
      }
    } catch { this.failures++; }
  }

  /** 最近 n 行（跨文件，旧 → 新）。 */
  tail(n: number): string[] {
    this.flush();
    const out: string[] = [];
    for (const f of this.files()) {
      let lines: string[] = [];
      try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
      out.unshift(...lines.slice(-(n - out.length)));
      if (out.length >= n) break;
    }
    return out.slice(-n);
  }

  dispose(): void { this.flush(); }
}
