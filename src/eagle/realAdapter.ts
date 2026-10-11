import type { AppInfo, EagleAdapter, FolderInfo, ItemFile, ItemInfo, LibrarySummary } from './adapter';

/* eslint-disable @typescript-eslint/no-explicit-any */

function api(): any {
  if (typeof eagle === 'undefined' || !eagle) throw new Error('eagle 全局对象不存在');
  return eagle;
}

function toItem(it: any): ItemInfo {
  return {
    id: String(it.id),
    name: String(it.name ?? ''),
    ext: String(it.ext ?? ''),
    size: Number(it.size ?? 0),
    folders: Array.isArray(it.folders) ? it.folders.map(String) : [],
    tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
    importedAt: Number(it.importedAt ?? 0),
    modifiedAt: Number(it.modifiedAt ?? 0)
  };
}

export class RealEagleAdapter implements EagleAdapter {
  appInfo(): AppInfo {
    const app = typeof eagle !== 'undefined' ? eagle?.app : undefined;
    return { version: String(app?.version ?? 'unknown'), build: Number(app?.build ?? 0) };
  }

  async libraryInfo(): Promise<LibrarySummary> {
    const info = await api().library.info();
    return {
      name: String(info.name ?? ''),
      path: String(info.path ?? ''),
      modificationTime: Number(info.modificationTime ?? 0),
      folderCount: Array.isArray(info.folders) ? info.folders.length : 0
    };
  }

  /**
   * folder.getAll() 的返回形态（扁平还是树）未确认，这里同时兼容：
   * 递归 children，按 id 去重；父子关系优先取遍历路径，其次取 parent 字段。
   */
  async getFolders(): Promise<FolderInfo[]> {
    const roots: any[] = await api().folder.getAll();
    const out = new Map<string, FolderInfo>();
    const visit = (f: any, via: string | null): void => {
      if (!f || f.id === undefined) return;
      const id = String(f.id);
      const parentField = typeof f.parent === 'string' ? f.parent : f.parent && f.parent.id ? String(f.parent.id) : null;
      const prev = out.get(id);
      if (!prev) {
        out.set(id, {
          id,
          name: String(f.name ?? ''),
          parentId: via ?? parentField,
          createdAt: Number(f.createdAt ?? f.modificationTime ?? 0)
        });
      } else if (prev.parentId === null && (via ?? parentField)) {
        prev.parentId = via ?? parentField;
      }
      if (Array.isArray(f.children)) for (const c of f.children) visit(c, id);
    };
    for (const f of roots) visit(f, null);
    return Array.from(out.values());
  }

  async getItems(folderId: string | null): Promise<ItemInfo[]> {
    const e = api();
    // 实测：带 fields 时 importedAt / modifiedAt 会变成 0，ETag 与排序都依赖它们，所以不用 fields。
    // 大库性能留待 M4（可改为 getIdsWithModifiedAt 补时间戳）。
    const query = (q: Record<string, unknown>): Promise<any[]> => e.item.get(q);
    if (folderId !== null) {
      return (await query({ folders: [folderId] })).map(toItem);
    }
    // 未分类：Plugin API 没有专门查询，取全库再过滤（大库较慢，由索引层缓存）
    return (await query({})).map(toItem).filter((i) => i.folders.length === 0);
  }

  /** 首次启动时的形态自检：把 Folder / Item 实际有哪些成员写进日志，便于核对适配假设。 */
  async diagnose(): Promise<string[]> {
    const lines: string[] = [];
    const members = (o: any): string => {
      const names = new Set<string>(Object.keys(o));
      for (let p = Object.getPrototypeOf(o); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        Object.getOwnPropertyNames(p).forEach((n) => names.add(n));
      }
      return Array.from(names).filter((n) => n !== 'constructor').join(',');
    };
    const raw: any[] = await api().folder.getAll();
    const flat = await this.getFolders();
    lines.push(`folder.getAll 返回 ${raw.length} 项，展开后 ${flat.length} 个文件夹，顶层 ${flat.filter((f) => f.parentId === null).length} 个`);
    if (raw[0]) lines.push('Folder 成员：' + members(raw[0]));
    const sample = (await api().item.get({ limit: 1 }).catch(() => []))[0];
    if (sample) {
      lines.push('Item 成员：' + members(sample));
      lines.push('item.get 示例：' + JSON.stringify(toItem(sample)));
    }
    return lines;
  }

  async getItemFile(id: string): Promise<ItemFile | null> {
    const it = await api().item.getById(id);
    if (!it || it.isDeleted || !it.filePath) return null;
    return { ...toItem(it), filePath: String(it.filePath) };
  }
}

export function userDataDir(): string | undefined {
  return typeof eagle !== 'undefined' ? eagle?.app?.userDataPath : undefined;
}
