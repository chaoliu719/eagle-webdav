import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImportTimeoutError, type AppInfo, type EagleAdapter, type FolderInfo, type FolderPatch, type ItemFile, type ItemInfo, type ItemPatch, type LibrarySummary } from './adapter';

/** 内存假实现，用于单元测试与不依赖 Eagle 的开发。条目文件真实写在临时资源库里。 */
export class FakeEagleAdapter implements EagleAdapter {
  app: AppInfo = { version: '4.0.0', build: 23 };
  libraryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-eagle-')) + '/fake.library';
  modificationTime = 1;
  folders: FolderInfo[] = [];
  items: Array<ItemInfo & { filePath: string }> = [];
  calls = { getFolders: 0, getItems: 0, libraryInfo: 0 };
  private seq = 0;

  appInfo(): AppInfo { return this.app; }

  async libraryInfo(): Promise<LibrarySummary> {
    this.calls.libraryInfo++;
    return { name: 'fake', path: this.libraryPath, modificationTime: this.modificationTime, folderCount: this.folders.length };
  }

  addFolder(name: string, parentId: string | null = null, createdAt = ++this.seq): FolderInfo {
    const f = { id: 'FLD' + String(++this.seq).padStart(6, '0'), name, parentId, createdAt };
    this.folders.push(f);
    this.modificationTime++;
    return f;
  }

  addItem(name: string, ext: string, content: string | Buffer, folders: string[] = [], importedAt = ++this.seq): ItemInfo & { filePath: string } {
    const id = 'ITM' + String(++this.seq).padStart(6, '0');
    const dir = path.join(this.libraryPath, 'images', id + '.info');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, name + (ext ? '.' + ext : ''));
    fs.writeFileSync(filePath, content);
    const it = { id, name, ext, size: fs.statSync(filePath).size, folders, tags: [], importedAt, modifiedAt: 1_700_000_000_000 + this.seq, star: 0, annotation: '', url: '', filePath };
    this.items.push(it);
    this.modificationTime++;
    return it;
  }

  /** 模拟 Eagle：回收站条目从 get / getById 中消失。 */
  trashed: string[] = [];
  /** 模拟「不识别格式」：这些扩展名的导入永不 resolve。 */
  hangExts = new Set<string>();

  private touch(it: { modifiedAt: number }): void { it.modifiedAt = Date.now(); this.modificationTime++; }

  async createFolder(name: string, parentId: string | null): Promise<FolderInfo> {
    return { ...this.addFolder(name, parentId) };
  }

  async updateFolder(id: string, patch: FolderPatch): Promise<FolderInfo> {
    const f = this.folders.find((x) => x.id === id);
    if (!f) throw new Error('文件夹不存在');
    if (patch.name !== undefined) f.name = patch.name;
    if (patch.parentId !== undefined) f.parentId = patch.parentId;
    this.modificationTime++;
    return { ...f };
  }

  async importFile(filePath: string, opts: { name: string; folders: string[]; timeoutMs?: number }): Promise<string> {
    const ext = path.extname(filePath).slice(1);
    if (this.hangExts.has(ext) || !ext) {
      await new Promise((_, rej) => setTimeout(() => rej(new ImportTimeoutError()), opts.timeoutMs ?? 20_000));
    }
    return this.addItem(opts.name, ext, fs.readFileSync(filePath), opts.folders).id;
  }

  async replaceFile(id: string, filePath: string): Promise<void> {
    const it = this.items.find((i) => i.id === id);
    if (!it) throw new Error('条目不存在');
    fs.copyFileSync(filePath, it.filePath);
    it.size = fs.statSync(it.filePath).size;
    this.touch(it);
  }

  async trashItem(id: string): Promise<void> {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('条目不存在');
    this.trashed.push(id);
    this.items.splice(i, 1);
    this.modificationTime++;
  }

  async updateItem(id: string, patch: ItemPatch): Promise<ItemFile> {
    const it = this.items.find((i) => i.id === id);
    if (!it) throw new Error('条目不存在');
    if (patch.name !== undefined && patch.name !== it.name) {
      // Eagle 实测：改名会真实重命名磁盘文件
      const np = path.join(path.dirname(it.filePath), patch.name + (it.ext ? '.' + it.ext : ''));
      fs.renameSync(it.filePath, np);
      it.filePath = np;
      it.name = patch.name;
    }
    if (patch.folders !== undefined) it.folders = [...patch.folders];
    if (patch.tags !== undefined) it.tags = [...patch.tags];
    if (patch.star !== undefined) it.star = patch.star;
    if (patch.annotation !== undefined) it.annotation = patch.annotation;
    if (patch.url !== undefined) it.url = patch.url;
    this.touch(it);
    return { ...it };
  }

  async getAllItems(): Promise<ItemInfo[]> {
    return this.items.map(({ filePath: _p, ...rest }) => ({ ...rest }));
  }

  async getFolders(): Promise<FolderInfo[]> { this.calls.getFolders++; return this.folders.map((f) => ({ ...f })); }

  async getItems(folderId: string | null): Promise<ItemInfo[]> {
    this.calls.getItems++;
    return this.items
      .filter((i) => (folderId === null ? i.folders.length === 0 : i.folders.includes(folderId)))
      .map(({ filePath: _p, ...rest }) => ({ ...rest }));
  }

  async getItemFile(id: string): Promise<ItemFile | null> {
    const it = this.items.find((i) => i.id === id);
    return it ? { ...it } : null;
  }
}
