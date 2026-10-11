import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SYSTEM_EXACT = new Set([
  '.ds_store', '.localized', '.hidden', '.apdisk', '.trashes', '.fseventsd', '.temporaryitems', '.spotlight-v100',
  'desktop.ini', 'thumbs.db'
]);

/** Finder、Windows、Office 等客户端产生的临时与探测文件，只进影子暂存区，永不入库。 */
export function isSystemName(name: string): boolean {
  const n = name.toLowerCase();
  return SYSTEM_EXACT.has(n) || n.startsWith('._') || n.startsWith('.metadata_never_index') || n.startsWith('~$') || n.startsWith('.sb-');
}

export interface ShadowEntry {
  key: string;
  name: string;
  isDir: boolean;
  size: number;
  /** 暂存文件路径；目录与 0 字节占位为 null。 */
  file: string | null;
  system: boolean;
  created: number;
  modified: number;
  touched: number;
}

const TTL_MS = 24 * 3600 * 1000;
const PLACEHOLDER_TTL_MS = 10 * 60 * 1000;
const MAX_BYTES = 512 * 1024 * 1024;

export function parentKeyOf(key: string): string {
  const i = key.lastIndexOf('/');
  return i <= 0 ? '/' : key.slice(0, i);
}

/**
 * 影子暂存区：吸收系统临时文件与 Finder 的 0 字节占位写入。
 * 内存索引 + 临时目录文件；24 小时 TTL，总量 512 MiB，按最近使用淘汰。
 * 没有内容的占位 10 分钟后丢弃。
 */
export class ShadowStore {
  private entries = new Map<string, ShadowEntry>();
  readonly dir: string;

  constructor(private now: () => number = Date.now, dir?: string) {
    this.dir = dir ?? path.join(os.tmpdir(), 'eagle-webdav', 'shadow-' + crypto.randomUUID());
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private purge(): void {
    const t = this.now();
    for (const [k, e] of this.entries) {
      const ttl = !e.system && !e.isDir && e.size === 0 ? PLACEHOLDER_TTL_MS : TTL_MS;
      if (t - e.touched > ttl) this.drop(k);
    }
    let total = this.totalBytes();
    if (total > MAX_BYTES) {
      const byAge = Array.from(this.entries.values()).sort((a, b) => a.touched - b.touched);
      for (const e of byAge) {
        if (total <= MAX_BYTES) break;
        total -= e.size;
        this.drop(e.key);
      }
    }
  }

  private drop(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    if (e.file) fs.promises.unlink(e.file).catch(() => undefined);
  }

  totalBytes(): number {
    let n = 0;
    this.entries.forEach((e) => { n += e.size; });
    return n;
  }

  get(key: string): ShadowEntry | null {
    this.purge();
    const e = this.entries.get(key);
    if (e) e.touched = this.now();
    return e ?? null;
  }

  /** 某目录下的非系统占位，用于 PROPFIND 列目录（系统文件不列出）。 */
  list(parentKey: string): ShadowEntry[] {
    this.purge();
    const out: ShadowEntry[] = [];
    this.entries.forEach((e) => { if (!e.system && parentKeyOf(e.key) === parentKey) out.push(e); });
    return out;
  }

  /** 是否位于某个影子目录之下（如 .Spotlight-V100/…）。 */
  hasShadowAncestor(key: string): boolean {
    let k = parentKeyOf(key);
    while (k !== '/') {
      if (this.entries.get(k)?.isDir) return true;
      k = parentKeyOf(k);
    }
    return false;
  }

  /** 为将要写入的内容分配暂存路径。 */
  allocPath(): string {
    return path.join(this.dir, crypto.randomUUID());
  }

  putFile(key: string, name: string, file: string | null, size: number): ShadowEntry {
    const old = this.entries.get(key);
    if (old?.file && old.file !== file) fs.promises.unlink(old.file).catch(() => undefined);
    const t = this.now();
    const e: ShadowEntry = {
      key, name, isDir: false, size, file, system: isSystemName(name),
      created: old?.created ?? t, modified: t, touched: t
    };
    this.entries.set(key, e);
    return e;
  }

  putDir(key: string, name: string): ShadowEntry {
    const t = this.now();
    const e: ShadowEntry = { key, name, isDir: true, size: 0, file: null, system: true, created: t, modified: t, touched: t };
    this.entries.set(key, e);
    return e;
  }

  remove(key: string): boolean {
    const had = this.entries.has(key);
    this.drop(key);
    const prefix = key + '/';
    for (const k of Array.from(this.entries.keys())) if (k.startsWith(prefix)) this.drop(k);
    return had;
  }

  /** 重命名（MOVE）。 */
  rename(from: string, toKey: string, toName: string): boolean {
    const e = this.entries.get(from);
    if (!e) return false;
    this.entries.delete(from);
    this.remove(toKey);
    this.entries.set(toKey, { ...e, key: toKey, name: toName, system: isSystemName(toName), modified: this.now() });
    return true;
  }

  clear(): void {
    for (const k of Array.from(this.entries.keys())) this.drop(k);
  }
}
