import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as os from 'os';

type Spawn = (cmd: string, args: string[]) => ChildProcess;

/**
 * dns-sd 没有 caffeinate 那样的 -w，宿主进程被直接结束时（卸载插件、Eagle 被强退）不会跟着退出，
 * 它会继续对外广播一个已经不存在的服务（2026-10-12 卸载实测留下了孤儿进程）。
 * 起一个很小的看门狗：宿主或 dns-sd 任何一个没了，就把 dns-sd 结束。
 */
export function defaultWatchdog(parentPid: number, childPid: number): ChildProcess {
  const script = 'while kill -0 "$1" 2>/dev/null && kill -0 "$2" 2>/dev/null; do sleep 2; done; kill "$2" 2>/dev/null';
  const w = spawn('/bin/sh', ['-c', script, 'sh', String(parentPid), String(childPid)], { stdio: 'ignore', detached: true });
  w.unref();
  return w;
}

/** 用系统自带的 dns-sd 注册 _webdav._tcp 服务，Infuse 等 App 可自动发现（Finder 的「网络」不会列出 WebDAV，实测）。仅 macOS。 */
export class Bonjour {
  private child: ChildProcess | null = null;
  private dog: ChildProcess | null = null;
  name = '';

  constructor(private opts: {
    spawnFn?: Spawn; platform?: string; watchdog?: (parentPid: number, childPid: number) => ChildProcess | null; hostname?: () => string; label?: () => string;
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
      if (child.pid) {
        try { this.dog = (this.opts.watchdog ?? defaultWatchdog)(process.pid, child.pid); } catch { this.dog = null; }
      }
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
    const d = this.dog;
    this.dog = null;
    try { d?.kill(); } catch { /* ignore */ }
  }
}
