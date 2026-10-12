import type { EagleAdapter, FolderInfo, ItemInfo } from '../eagle/adapter';

const FRESH_CHECK_MS = 1500;
const MAX_AGE_MS = 60_000;
/** 目录缓存里最多保留的条目记录数（LRU 淘汰）。 */
const MAX_CACHED_ITEMS = 200_000;

/**
 * 文件夹树与按目录懒加载的条目缓存。
 * 通过 library.info().modificationTime 判断是否有任何编辑，变化则整体失效；
 * 兜底最长 60 秒过期。
 */
export class LibraryIndex {
  private folderPromise: Promise<FolderInfo[]> | null = null;
  private itemPromises = new Map<string, Promise<ItemInfo[]>>();
  private itemCounts = new Map<string, number>();
  private cachedItems = 0;
  private tagPromise: Promise<string[]> | null = null;
  /** 每次缓存失效都会递增，派生缓存（目录列表）据此判断是否过期。 */
  revision = 0;
  /** 本服务替换过内容的条目 → 时间戳。Eagle 的 replaceFile 不更新 modifiedAt，靠它让 ETag 随内容变化。 */
  private touched = new Map<string, number>();
  private libMod = -1;
  private libPath = '';
  private checkedAt = 0;
  private loadedAt = 0;
  private checking: Promise<void> | null = null;

  constructor(private adapter: EagleAdapter, private now: () => number = Date.now) {}

  private clear(): void {
    this.folderPromise = null;
    this.tagPromise = null;
    this.itemPromises.clear();
    this.itemCounts.clear();
    this.cachedItems = 0;
    this.revision++;
  }

  invalidate(): void {
    this.clear();
    this.libMod = -1;
    this.checkedAt = 0;
  }

  /** 记录条目内容被本服务替换。 */
  touch(id: string): void {
    this.touched.set(id, Date.now());
  }

  /**
   * 统一条目的"有效修改时间"：新导入的条目 modifiedAt 为 0（实测，仅编辑后才更新），
   * 此时退回 importedAt；再与本服务替换内容的时间取较大者。
   */
  normalize<T extends ItemInfo>(it: T): T {
    const base = it.modifiedAt || it.importedAt || 0;
    const t = this.touched.get(it.id) ?? 0;
    const eff = Math.max(base, t);
    return eff === it.modifiedAt ? it : { ...it, modifiedAt: eff };
  }

  /** 检查资源库是否有变化，有则让缓存失效。 */
  async ensureFresh(): Promise<void> {
    const t = this.now();
    if (t - this.checkedAt < FRESH_CHECK_MS && this.libMod !== -1) return;
    if (!this.checking) {
      this.checking = (async () => {
        const info = await this.adapter.libraryInfo();
        const stale = info.modificationTime !== this.libMod || info.path !== this.libPath || this.now() - this.loadedAt > MAX_AGE_MS;
        if (stale) {
          this.clear();
          this.loadedAt = this.now();
        }
        this.libMod = info.modificationTime;
        this.libPath = info.path;
        this.checkedAt = this.now();
      })().finally(() => { this.checking = null; });
    }
    await this.checking;
  }

  /** 最近一次读到的资源库修改时间，用作目录的 getlastmodified 兜底。 */
  async modificationTime(): Promise<number> {
    await this.ensureFresh();
    return this.libMod;
  }

  async libraryPath(): Promise<string> {
    await this.ensureFresh();
    return this.libPath;
  }

  async folders(): Promise<FolderInfo[]> {
    await this.ensureFresh();
    if (!this.folderPromise) {
      const p = this.adapter.getFolders();
      p.catch(() => { if (this.folderPromise === p) this.folderPromise = null; });
      this.folderPromise = p;
    }
    return this.folderPromise;
  }

  async tags(): Promise<string[]> {
    await this.ensureFresh();
    if (!this.tagPromise) {
      const p = this.adapter.getTags();
      p.catch(() => { if (this.tagPromise === p) this.tagPromise = null; });
      this.tagPromise = p;
    }
    return this.tagPromise;
  }

  /** folderId 为 null 表示未分类。 */
  items(folderId: string | null): Promise<ItemInfo[]> {
    return this.cachedItemsFor('f:' + (folderId ?? ''), () => this.adapter.getItems(folderId));
  }

  itemsByTag(tag: string): Promise<ItemInfo[]> {
    return this.cachedItemsFor('t:' + tag, () => this.adapter.getItemsByTag(tag));
  }

  allItems(): Promise<ItemInfo[]> {
    return this.cachedItemsFor('all', () => this.adapter.getAllItems());
  }

  private async cachedItemsFor(key: string, load: () => Promise<ItemInfo[]>): Promise<ItemInfo[]> {
    await this.ensureFresh();
    let p = this.itemPromises.get(key);
    if (p) {
      // 命中：移到末尾，表示最近使用
      this.itemPromises.delete(key);
      this.itemPromises.set(key, p);
      return p;
    }
    const created = load().then((list) => list.map((i) => this.normalize(i)));
    created.then((list) => {
      if (this.itemPromises.get(key) !== created) return;
      this.itemCounts.set(key, list.length);
      this.cachedItems += list.length;
      for (const k of this.itemPromises.keys()) {
        if (this.cachedItems <= MAX_CACHED_ITEMS || k === key) break;
        this.cachedItems -= this.itemCounts.get(k) ?? 0;
        this.itemCounts.delete(k);
        this.itemPromises.delete(k);
      }
    }, () => { if (this.itemPromises.get(key) === created) this.itemPromises.delete(key); });
    this.itemPromises.set(key, created);
    p = created;
    return p;
  }
}
