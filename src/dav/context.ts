import type { EagleAdapter } from '../eagle/adapter';
import type { LibraryIndex } from '../index/libraryIndex';
import type { KeyedMutex } from '../util/mutex';
import type { Logger } from '../util/log';
import type { ShadowStore } from '../vfs/shadow';
import type { Resolver } from '../vfs/resolver';
import type { LockManager } from './locks';

export interface DeadProp { ns: string; name: string; value: string }

/** 各方法处理器共享的依赖。 */
export interface DavContext {
  adapter: EagleAdapter;
  index: LibraryIndex;
  resolver: Resolver;
  locks: LockManager;
  shadow: ShadowStore;
  logger: Logger;
  mutex: KeyedMutex;
  /** PUT 的临时目录根。 */
  tmpRoot: string;
  /** PUT 体积上限（字节）。 */
  maxPut: number;
  /** 其他命名空间的 dead 属性，只保存在内存（Finder 等会写）。 */
  deadProps: Map<string, Map<string, DeadProp>>;
}
