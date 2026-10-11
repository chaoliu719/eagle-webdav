import type { FolderInfo, ItemInfo } from '../eagle/adapter';
import type { LibraryIndex } from '../index/libraryIndex';
import { buildEntries, matchEntry, type Entry } from './naming';

export const UNCATEGORIZED = '@未分类';

export type Resolved =
  | { kind: 'root'; segs: string[] }
  | { kind: 'uncat'; segs: string[] }
  | { kind: 'folder'; segs: string[]; folder: FolderInfo }
  | { kind: 'item'; segs: string[]; item: ItemInfo; parentFolderId: string | null };

export function isCollection(r: Resolved): boolean {
  return r.kind !== 'item';
}

/** 规范路径，用作锁等按路径索引的键。 */
export function pathKey(segs: string[]): string {
  return segs.length ? '/' + segs.join('/') : '/';
}

export class Resolver {
  constructor(private index: LibraryIndex) {}

  /** 目录子项（含消歧后的名字）。 */
  async children(r: Resolved): Promise<Entry[]> {
    if (r.kind === 'item') return [];
    const folders = await this.index.folders();
    if (r.kind === 'root') {
      const top = folders.filter((f) => f.parentId === null);
      return [{ name: UNCATEGORIZED, kind: 'uncat', id: '' }, ...buildEntries(top, [], [UNCATEGORIZED])];
    }
    if (r.kind === 'uncat') {
      return buildEntries([], await this.index.items(null));
    }
    const subs = folders.filter((f) => f.parentId === r.folder.id);
    return buildEntries(subs, await this.index.items(r.folder.id));
  }

  /** 把已解码、已 NFC 的路径段解析为节点；不存在返回 null。 */
  async resolve(segs: string[]): Promise<Resolved | null> {
    let cur: Resolved = { kind: 'root', segs: [] };
    for (let i = 0; i < segs.length; i++) {
      if (cur.kind === 'item') return null;
      if (cur.kind === 'root' && segs[i].normalize('NFC') === UNCATEGORIZED) {
        cur = { kind: 'uncat', segs: [UNCATEGORIZED] };
        continue;
      }
      const entries = await this.children(cur);
      const hit = matchEntry(entries, segs[i]);
      if (!hit) return null;
      const next: string[] = [...cur.segs, hit.name];
      if (hit.kind === 'uncat') {
        cur = { kind: 'uncat', segs: [UNCATEGORIZED] };
      } else if (hit.kind === 'folder') {
        cur = { kind: 'folder', segs: next, folder: hit.folder as FolderInfo };
      } else {
        cur = {
          kind: 'item', segs: next, item: hit.item as ItemInfo,
          parentFolderId: cur.kind === 'folder' ? cur.folder.id : null
        };
      }
    }
    return cur;
  }
}
