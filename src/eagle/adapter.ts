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

export interface EagleAdapter {
  appInfo(): AppInfo;
  libraryInfo(): Promise<LibrarySummary>;
}

/** Plugin API 硬性要求的最低 build。 */
export const MIN_BUILD = 12;
