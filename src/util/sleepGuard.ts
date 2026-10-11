import { spawn, type ChildProcess } from 'child_process';

type Spawn = (cmd: string, args: string[]) => ChildProcess;

/**
 * 防休眠：有请求在处理、或刚结束不久（idleMs 内）时，保持一个 `caffeinate -i` 子进程
 * 阻止 Mac 空闲休眠；空闲后结束它。仅 macOS。
 */
export class SleepGuard {
  private child: ChildProcess | null = null;
  private inflight = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private opts: { enabled: () => boolean; idleMs?: number; spawnFn?: Spawn; platform?: string } = { enabled: () => true }
  ) {}

  private get idleMs(): number { return this.opts.idleMs ?? 60_000; }
  private get supported(): boolean { return (this.opts.platform ?? process.platform) === 'darwin'; }

  get active(): boolean { return this.child !== null; }

  begin(): void {
    this.inflight++;
    this.ensure();
  }

  end(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.armIdle();
  }

  private ensure(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.child || !this.supported || !this.opts.enabled()) return;
    const spawnFn: Spawn = this.opts.spawnFn ?? ((c, a) => spawn(c, a, { stdio: 'ignore' }));
    try {
      // -w：被监视的进程（Eagle 的渲染进程）退出时 caffeinate 自己也退出，避免遗留
      const child = spawnFn('caffeinate', ['-i', '-w', String(process.pid)]);
      child.on('exit', () => { if (this.child === child) this.child = null; });
      child.on('error', () => { if (this.child === child) this.child = null; });
      this.child = child;
    } catch {
      this.child = null;
    }
  }

  private armIdle(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.inflight > 0) return;
    this.timer = setTimeout(() => this.release(), this.idleMs);
    this.timer.unref?.();
  }

  /** 立即放开（服务停止或退出时）。 */
  release(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const c = this.child;
    this.child = null;
    try { c?.kill(); } catch { /* ignore */ }
  }
}
