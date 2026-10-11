import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppInfo, EagleAdapter, FolderInfo, ItemFile, ItemInfo, LibrarySummary } from './adapter';

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
    const it = { id, name, ext, size: fs.statSync(filePath).size, folders, tags: [], importedAt, modifiedAt: 1_700_000_000_000 + this.seq, filePath };
    this.items.push(it);
    this.modificationTime++;
    return it;
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
