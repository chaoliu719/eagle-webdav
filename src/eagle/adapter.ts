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
}

/** 可读文件信息：filePath 每次实时读取（改名会改变磁盘文件名）。 */
export interface ItemFile extends ItemInfo {
  filePath: string;
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
}

/** Plugin API 硬性要求的最低 build。 */
export const MIN_BUILD = 12;
