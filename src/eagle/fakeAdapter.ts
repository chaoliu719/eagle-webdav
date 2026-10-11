import type { AppInfo, EagleAdapter, LibrarySummary } from './adapter';

/** 内存假实现，用于单元测试与不依赖 Eagle 的开发。 */
export class FakeEagleAdapter implements EagleAdapter {
  app: AppInfo = { version: '4.0.0', build: 23 };
  library: LibrarySummary = { name: 'fake', path: '/tmp/fake.library', modificationTime: 1, folderCount: 0 };

  appInfo(): AppInfo { return this.app; }
  async libraryInfo(): Promise<LibrarySummary> { return this.library; }
}
