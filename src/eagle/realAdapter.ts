import type { AppInfo, EagleAdapter, LibrarySummary } from './adapter';

export class RealEagleAdapter implements EagleAdapter {
  appInfo(): AppInfo {
    const app = typeof eagle !== 'undefined' ? eagle?.app : undefined;
    return { version: String(app?.version ?? 'unknown'), build: Number(app?.build ?? 0) };
  }

  async libraryInfo(): Promise<LibrarySummary> {
    if (typeof eagle === 'undefined' || !eagle) throw new Error('eagle 全局对象不存在');
    const info = await eagle.library.info();
    return {
      name: String(info.name ?? ''),
      path: String(info.path ?? ''),
      modificationTime: Number(info.modificationTime ?? 0),
      folderCount: Array.isArray(info.folders) ? info.folders.length : 0
    };
  }
}

export function userDataDir(): string | undefined {
  return typeof eagle !== 'undefined' ? eagle?.app?.userDataPath : undefined;
}
