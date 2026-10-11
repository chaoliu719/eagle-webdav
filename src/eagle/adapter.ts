// 适配层接口。整个项目只有 realAdapter.ts 可以直接碰全局 eagle 对象。
export interface AppInfo {
  version: string;
  build: number;
}

export interface LibrarySummary {
  name: string;
  path: string;
  modificationTime: number;
  folderCount: number;
}

export interface FolderInfo {
  id: string;
  name: string;
  /** 顶层文件夹为 null。 */
  parentId: string | null;
  createdAt: number;
}

export interface ItemInfo {
  id: string;
  name: string;
  /** 不含点；可能为空。 */
  ext: string;
  size: number;
  folders: string[];
  tags: string[];
  importedAt: number;
  modifiedAt: number;
  star: number;
  annotation: string;
  url: string;
}

/** 可读文件信息：filePath 每次实时读取（改名会改变磁盘文件名）。 */
export interface ItemFile extends ItemInfo {
  filePath: string;
}

export interface ItemPatch {
  /** 不含扩展名。 */
  name?: string;
  folders?: string[];
  tags?: string[];
  star?: number;
  annotation?: string;
  url?: string;
}

export interface FolderPatch {
  name?: string;
  /** null 表示移到根目录。 */
  parentId?: string | null;
  description?: string;
}

/** 导入超时（无扩展名或不识别的格式 Eagle 会永不 resolve）。 */
export class ImportTimeoutError extends Error {
  constructor() { super('导入超时：Eagle 可能不识别该文件格式'); this.name = 'ImportTimeoutError'; }
}

export interface EagleAdapter {
  appInfo(): AppInfo;
  libraryInfo(): Promise<LibrarySummary>;
  /** 全部文件夹（扁平，含层级关系）。 */
  getFolders(): Promise<FolderInfo[]>;
  /** 某文件夹直属条目；null 表示未分类（不属于任何文件夹）。 */
  getItems(folderId: string | null): Promise<ItemInfo[]>;
  /** 实时读取单个条目；已进回收站或不存在返回 null。 */
  getItemFile(id: string): Promise<ItemFile | null>;

  /** 全部标签名。 */
  getTags(): Promise<string[]>;
  /** 带某标签的条目（可属于任意文件夹）。 */
  getItemsByTag(tag: string): Promise<ItemInfo[]>;

  // ---------- 写入 ----------
  createFolder(name: string, parentId: string | null): Promise<FolderInfo>;
  updateFolder(id: string, patch: FolderPatch): Promise<FolderInfo>;
  /** 导入磁盘文件（Eagle 会复制）。超时抛 ImportTimeoutError。返回新条目 id。 */
  importFile(filePath: string, opts: { name: string; folders: string[]; timeoutMs?: number }): Promise<string>;
  replaceFile(id: string, filePath: string): Promise<void>;
  /** 移入回收站（Plugin API 没有永久删除）。 */
  trashItem(id: string): Promise<void>;
  /** 基于最新数据修改并 save()，返回保存后的条目。 */
  updateItem(id: string, patch: ItemPatch): Promise<ItemFile>;
}

/** Plugin API 硬性要求的最低 build。 */
export const MIN_BUILD = 12;
