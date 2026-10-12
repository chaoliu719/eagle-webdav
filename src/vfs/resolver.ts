import type { FolderInfo, ItemInfo } from '../eagle/adapter';
import type { LibraryIndex } from '../index/libraryIndex';
import { buildEntries, EntryIndex, type Entry } from './naming';
import type { ShadowEntry, ShadowStore } from './shadow';

export const UNCATEGORIZED = '@未分类';
export const TAGS_VIEW = '@标签';
export const ALL_VIEW = '@全部';

export type Resolved =
  | { kind: 'root'; segs: string[] }
  | { kind: 'uncat'; segs: string[] }
  | { kind: 'all'; segs: string[] }
  | { kind: 'tags'; segs: string[] }
  | { kind: 'tag'; segs: string[]; tag: string }
  | { kind: 'folder'; segs: string[]; folder: FolderInfo }
  | { kind: 'item'; segs: string[]; item: ItemInfo; parentFolderId: string | null; viaView?: boolean }
  | { kind: 'shadow'; segs: string[]; entry: ShadowEntry };

export function isCollection(r: Resolved): boolean {
  return r.kind === 'shadow' ? r.entry.isDir : r.kind !== 'item';
}

/** 「@标签」「@全部」视图及其下的条目只读。 */
export function isReadOnlyView(r: Resolved): boolean {
  return r.kind === 'tags' || r.kind === 'tag' || r.kind === 'all' || (r.kind === 'item' && r.viaView === true);
}

/** 规范路径，用作锁等按路径索引的键。 */
export function pathKey(segs: string[]): string {
  return segs.length ? '/' + segs.join('/') : '/';
}

type Real = Exclude<Resolved, { kind: 'item' | 'shadow' }>;

export interface ResolverOptions {
  /** 是否暴露只读的「@标签」视图。 */
  tagsView?: () => boolean;
  /** 是否暴露只读的「@全部」视图。 */
  allView?: () => boolean;
}

export class Resolver {
  /** 目录子项缓存：键 → { 缓存修订号, 索引 }。索引失效（revision 变化）后自动重建。 */
  private listings = new Map<string, { rev: number; index: EntryIndex }>();

  constructor(private index: LibraryIndex, private shadow?: ShadowStore, private opts: ResolverOptions = {}) {}

  private tagsEnabled(): boolean { return this.opts.tagsView ? this.opts.tagsView() : false; }

  private allEnabled(): boolean { return this.opts.allView ? this.opts.allView() : false; }

  private listingKey(r: Real): string {
    switch (r.kind) {
      case 'root': return 'root';
      case 'uncat': return 'uncat';
      case 'all': return 'all';
      case 'tags': return 'tags';
      case 'tag': return 'tag:' + r.tag;
      case 'folder': return 'folder:' + r.folder.id;
    }
  }

  private async listing(r: Real): Promise<EntryIndex> {
    // 先做新鲜度检查，再比较修订号
    await this.index.ensureFresh();
    const key = this.listingKey(r) + (r.kind === 'root' ? (this.tagsEnabled() ? ':t' : '') + (this.allEnabled() ? ':a' : '') : '');
    const hit = this.listings.get(key);
    if (hit && hit.rev === this.index.revision) return hit.index;
    const entries = await this.realChildren(r);
    const built = new EntryIndex(entries);
    this.listings.set(key, { rev: this.index.revision, index: built });
    if (this.listings.size > 2000) this.listings.delete(this.listings.keys().next().value as string);
    return built;
  }

  /** 目录子项（含消歧后的名字，以及影子占位）。 */
  async children(r: Resolved): Promise<Entry[]> {
    if (r.kind === 'item') return [];
    const shadows = (this.shadow?.list(pathKey(r.segs)) ?? []).map((e): Entry => ({ name: e.name, kind: 'shadow', id: '', shadow: e }));
    if (r.kind === 'shadow') return r.entry.isDir ? shadows : [];
    const real = (await this.listing(r)).entries;
    if (!shadows.length) return real;
    const taken = new Set(real.map((e) => e.name.toLowerCase()));
    return [...real, ...shadows.filter((e) => !taken.has(e.name.toLowerCase()))];
  }

  private async realChildren(r: Real): Promise<Entry[]> {
    switch (r.kind) {
      case 'root': {
        const folders = await this.index.folders();
        const top = folders.filter((f) => f.parentId === null);
        const virtual: Entry[] = [{ name: UNCATEGORIZED, kind: 'uncat', id: '' }];
        const reserved = [UNCATEGORIZED];
        if (this.tagsEnabled()) { virtual.push({ name: TAGS_VIEW, kind: 'tags', id: '' }); reserved.push(TAGS_VIEW); }
        if (this.allEnabled()) { virtual.push({ name: ALL_VIEW, kind: 'all', id: '' }); reserved.push(ALL_VIEW); }
        return [...virtual, ...buildEntries(top, [], reserved)];
      }
      case 'uncat':
        return buildEntries([], await this.index.items(null));
      case 'all':
        return buildEntries([], await this.index.allItems());
      case 'tags': {
        // 标签名当作"文件夹"走同一套消歧；id 用标签名，冲突后缀取其末尾
        const tags = await this.index.tags();
        const fake: FolderInfo[] = tags.map((t) => ({ id: t, name: t, parentId: null, createdAt: 0 }));
        return buildEntries(fake, []).map((e): Entry => ({ name: e.name, kind: 'tag', id: e.id }));
      }
      case 'tag':
        return buildEntries([], await this.index.itemsByTag(r.tag));
      case 'folder': {
        const folders = await this.index.folders();
        const subs = folders.filter((f) => f.parentId === r.folder.id);
        return buildEntries(subs, await this.index.items(r.folder.id));
      }
    }
  }

  /** 把已解码、已 NFC 的路径段解析为节点；不存在返回 null。 */
  async resolve(segs: string[]): Promise<Resolved | null> {
    let cur: Resolved = { kind: 'root', segs: [] };
    for (let i = 0; i < segs.length; i++) {
      if (cur.kind === 'item') return null;
      if (cur.kind === 'shadow') {
        if (!cur.entry.isDir) return null;
        const child: ShadowEntry | null | undefined = this.shadow?.get(pathKey([...cur.segs, segs[i]]));
        if (!child) return null;
        cur = { kind: 'shadow', segs: [...cur.segs, child.name], entry: child };
        continue;
      }
      const hit = (await this.listing(cur)).match(segs[i]);
      if (!hit) {
        const sh: ShadowEntry | null | undefined = this.shadow?.get(pathKey([...cur.segs, segs[i].normalize('NFC')]));
        if (!sh) return null;
        cur = { kind: 'shadow', segs: [...cur.segs, sh.name], entry: sh };
        continue;
      }
      const next: string[] = [...cur.segs, hit.name];
      switch (hit.kind) {
        case 'uncat': cur = { kind: 'uncat', segs: next }; break;
        case 'all': cur = { kind: 'all', segs: next }; break;
        case 'tags': cur = { kind: 'tags', segs: next }; break;
        case 'tag': cur = { kind: 'tag', segs: next, tag: hit.id }; break;
        case 'folder': cur = { kind: 'folder', segs: next, folder: hit.folder as FolderInfo }; break;
        default:
          cur = {
            kind: 'item', segs: next, item: hit.item as ItemInfo,
            parentFolderId: cur.kind === 'folder' ? cur.folder.id : null,
            viaView: cur.kind === 'tag' || cur.kind === 'all'
          };
      }
    }
    return cur;
  }
}
