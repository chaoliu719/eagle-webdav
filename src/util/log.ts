export interface RequestEntry {
  n: number;
  t: string;
  ip: string;
  method: string;
  url: string;
  status: number | 'aborted';
  ms: number;
  ua?: string;
  depth?: string;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  request(entry: RequestEntry): void;
}

const RING_SIZE = 500;

/**
 * 日志：请求摘要保留在内存环里供状态窗口显示，其余同步写入 eagle.log（若存在）。
 * 不记录 Authorization 头与密码。
 */
export class RingLogger implements Logger {
  private ring: RequestEntry[] = [];
  private lines: string[] = [];
  private listeners = new Set<() => void>();

  constructor(private sink?: (level: 'info' | 'warn' | 'error', msg: string) => void) {}

  info(msg: string): void { this.out('info', msg); }
  warn(msg: string): void { this.out('warn', msg); }
  error(msg: string): void { this.out('error', msg); }

  request(entry: RequestEntry): void {
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.listeners.forEach((fn) => fn());
  }

  recent(count = RING_SIZE): RequestEntry[] { return this.ring.slice(-count); }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private out(level: 'info' | 'warn' | 'error', msg: string): void {
    try { this.sink?.(level, msg); } catch { /* 日志本身不能让服务崩溃 */ }
    this.listeners.forEach((fn) => fn());
    this.lines.push(`[${new Date().toISOString().slice(11, 19)}] ${level} ${msg}`);
    if (this.lines.length > RING_SIZE) this.lines.shift();
  }

  messages(): string[] { return this.lines.slice(); }
}
