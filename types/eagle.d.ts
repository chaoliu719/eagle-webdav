// 只声明已在 Eagle 4.0.0 Build 23 实测存在、且 M1 用到的部分。见 CLAUDE.md「实测事实」。
interface EagleLibraryInfo {
  name?: string;
  path?: string;
  modificationTime?: number;
  folders?: unknown[];
}

interface EagleApp {
  version?: string;
  build?: number;
  // 未实测：用前先判断是否存在
  userDataPath?: string;
}

interface EagleGlobal {
  app?: EagleApp;
  library: { info(): Promise<EagleLibraryInfo> };
  log?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void; debug?(msg: string): void };
  onPluginCreate?(cb: (plugin: unknown) => void): void;
  onPluginRun?(cb: () => void): void;
  onPluginShow?(cb: () => void): void;
  onPluginHide?(cb: () => void): void;
  onPluginBeforeExit?(cb: () => void): void;
  onLibraryChanged?(cb: (libraryPath: string) => void): void;
}

declare const eagle: EagleGlobal | undefined;
