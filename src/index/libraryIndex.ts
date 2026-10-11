import type { EagleAdapter, FolderInfo, ItemInfo } from '../eagle/adapter';

const FRESH_CHECK_MS = 1500;
const MAX_AGE_MS = 60_000;

/**
 * 文件夹树与按目录懒加载的条目缓存。
 * 通过 library.info().modificationTime 判断是否有任何编辑，变化则整体失效；
 * 兜底最长 60 秒过期。
 */
export class LibraryIndex {
  private folderPromise: Promise<FolderInfo[]> | null = null;
  private itemPromises = new Map<string, Promise<ItemInfo[]>>();
  private libMod = -1;
  private libPath = '';
  private checkedAt = 0;
  private loadedAt = 0;
  private checking: Promise<void> | null = null;

  constructor(private adapter: EagleAdapter, private now: () => number = Date.now) {}

  invalidate(): void {
    this.folderPromise = null;
    this.itemPromises.clear();
    this.libMod = -1;
    this.checkedAt = 0;
  }

  private async refresh(): Promise<void> {
    const t = this.now();
    if (t - this.checkedAt < FRESH_CHECK_MS && this.libMod !== -1) return;
    if (!this.checking) {
      this.checking = (async () => {
        const info = await this.adapter.libraryInfo();
        const stale = info.modificationTime !== this.libMod || info.path !== this.libPath || this.now() - this.loadedAt > MAX_AGE_MS;
        if (stale) {
          this.folderPromise = null;
          this.itemPromises.clear();
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
    await this.refresh();
    return this.libMod;
  }

  async libraryPath(): Promise<string> {
    await this.refresh();
    return this.libPath;
  }

  async folders(): Promise<FolderInfo[]> {
    await this.refresh();
    if (!this.folderPromise) {
      const p = this.adapter.getFolders();
      p.catch(() => { if (this.folderPromise === p) this.folderPromise = null; });
      this.folderPromise = p;
    }
    return this.folderPromise;
  }

  /** folderId 为 null 表示未分类。 */
  async items(folderId: string | null): Promise<ItemInfo[]> {
    await this.refresh();
    const key = folderId ?? '';
    let p = this.itemPromises.get(key);
    if (!p) {
      const created = this.adapter.getItems(folderId);
      created.catch(() => { if (this.itemPromises.get(key) === created) this.itemPromises.delete(key); });
      this.itemPromises.set(key, created);
      p = created;
    }
    return p;
  }
}
