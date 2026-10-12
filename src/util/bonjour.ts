import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as os from 'os';

type Spawn = (cmd: string, args: string[]) => ChildProcess;

/** 用系统自带的 dns-sd 注册 _webdav._tcp 服务，Infuse 等 App 可自动发现（Finder 的「网络」不会列出 WebDAV，实测）。仅 macOS。 */
export class Bonjour {
  private child: ChildProcess | null = null;
  name = '';

  constructor(private opts: {
    spawnFn?: Spawn; platform?: string; hostname?: () => string; label?: () => string;
    /** dns-sd 起不来或意外退出时回调（主动 stop() 不算）。 */
    onFail?: () => void;
  } = {}) {}

  get active(): boolean { return this.child !== null; }

  /** 清理上一个插件实例（重载页面、异常退出）遗留的 dns-sd 注册进程。 */
  static killStale(): void {
    if (process.platform !== 'darwin') return;
    try { spawnSync('pkill', ['-f', 'dns-sd -R Eagle '], { stdio: 'ignore' }); } catch { /* ignore */ }
  }

  start(port: number): boolean {
    this.stop();
    Bonjour.killStale();
    if ((this.opts.platform ?? process.platform) !== 'darwin') return false;
    const host = (this.opts.hostname ?? os.hostname)().split('.')[0] || 'Mac';
    this.name = `${this.opts.label?.() ?? 'Eagle 素材库'} (${host})`;
    const spawnFn: Spawn = this.opts.spawnFn ?? ((c, a) => spawn(c, a, { stdio: 'ignore' }));
    try {
      const child = spawnFn('dns-sd', ['-R', this.name, '_webdav._tcp', 'local', String(port), 'path=/', 'txtvers=1']);
      const dropped = () => {
        if (this.child !== child) return; // 主动 stop() 过的，不算失败
        this.child = null;
        try { this.opts.onFail?.(); } catch { /* ignore */ }
      };
      child.on('exit', dropped);
      child.on('error', dropped);
      this.child = child;
      return true;
    } catch {
      this.child = null;
      try { this.opts.onFail?.(); } catch { /* ignore */ }
      return false;
    }
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    try { c?.kill(); } catch { /* ignore */ }
  }
}
