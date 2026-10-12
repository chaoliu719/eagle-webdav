import { currentCtx } from './reqctx';

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
  /** 请求的 Range 头与响应的 Content-Range / Content-Length，排查流媒体客户端用。 */
  range?: string;
  contentRange?: string;
  length?: string;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];
const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** 文件日志的写入端（FileLog 实现它；测试里可以替换）。 */
export interface LogSink { write(rec: object): void }

export interface Logger {
  /**
   * 结构化日志：cat 分类（svc / req / eagle / idx / imp / cli / sys / perf / auth / proc），
   * ev 事件名，fields 事件字段；text 是给窗口与 eagle.log 看的一句话（省略则由字段拼出）。
   * 在请求里调用时自动带上请求号 rid。
   */
  log(level: LogLevel, cat: string, ev: string, fields?: Record<string, unknown>, text?: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  request(entry: RequestEntry): void;
  /**
   * 需要用户处理的问题（持续到解决，在窗口里是横幅，同时发 Eagle 系统通知）：
   * key 相同的会覆盖，clearNotice 撤销。一次性的操作结果不走这里，用窗口里的 toast。
   */
  notice(key: string, message: string, opts?: NoticeOptions): void;
  clearNotice(key: string): void;
}

export interface NoticeAction { label: string; run(): void }

export interface NoticeOptions {
  /** error = 红色（出了故障）；warn = 黄色（在等你处理）。默认 warn。 */
  kind?: 'error' | 'warn';
  title?: string;
  /** 横幅上的按钮。warn 没给时默认一个「忽略」；error 没给则没有按钮（自己恢复）。 */
  actions?: NoticeAction[];
}

export interface Notice {
  key: string;
  message: string;
  t: number;
  kind: 'error' | 'warn';
  title?: string;
  actions: NoticeAction[];
}

const RING_SIZE = 500;

function brief(v: unknown): string {
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 57) + '…' : v;
  if (v && typeof v === 'object') { const j = JSON.stringify(v); return j.length > 60 ? j.slice(0, 57) + '…' : j; }
  return String(v);
}

/**
 * 日志：请求摘要保留在内存环里供状态窗口显示，其余同步写入 eagle.log（若存在）。
 * 不记录 Authorization 头与密码。
 */
export class RingLogger implements Logger {
  private ring: RequestEntry[] = [];
  private lines: string[] = [];
  private listeners = new Set<() => void>();
  private notices = new Map<string, Notice>();
  onNotice?: (n: Notice) => void;

  /** 写入文件的最低级别（debug 最详细）；窗口与 eagle.log 只收 info 及以上，除非这里设成 debug。 */
  level: LogLevel = 'info';
  file?: LogSink;

  constructor(private sink?: (level: 'info' | 'warn' | 'error', msg: string) => void) {}

  info(msg: string): void { this.log('info', 'misc', 'msg', { msg }, msg); }
  warn(msg: string): void { this.log('warn', 'misc', 'msg', { msg }, msg); }
  error(msg: string): void { this.log('error', 'misc', 'msg', { msg }, msg); }

  log(level: LogLevel, cat: string, ev: string, fields: Record<string, unknown> = {}, text?: string): void {
    if (RANK[level] > RANK[this.level]) return;
    const rid = currentCtx()?.rid;
    const rec = { ts: new Date().toISOString(), level, cat, ev, ...(rid ? { rid } : {}), ...fields };
    try { this.file?.write(rec); } catch { /* 日志本身不能让服务崩溃 */ }
    const line = text ?? `${cat}.${ev} ` + Object.entries(fields).map(([k, v]) => `${k}=${brief(v)}`).join(' ');
    this.out(level === 'debug' ? 'info' : level, line.trim());
  }

  request(entry: RequestEntry): void {
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.listeners.forEach((fn) => fn());
  }

  notice(key: string, message: string, opts: NoticeOptions = {}): void {
    const isNew = !this.notices.has(key);
    const kind = opts.kind ?? 'warn';
    const actions = opts.actions ?? (kind === 'warn' ? [{ label: '忽略', run: () => this.clearNotice(key) }] : []);
    const n: Notice = { key, message, t: Date.now(), kind, title: opts.title, actions };
    this.notices.set(key, n);
    this.log(kind === 'error' ? 'error' : 'warn', 'notice', key, { title: opts.title, message }, (opts.title ? opts.title + '：' : '') + message);
    if (isNew) { try { this.onNotice?.(n); } catch { /* ignore */ } }
  }

  clearNotice(key: string): void {
    if (this.notices.delete(key)) this.listeners.forEach((fn) => fn());
  }

  activeNotices(): Notice[] { return Array.from(this.notices.values()).sort((a, b) => b.t - a.t); }

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
