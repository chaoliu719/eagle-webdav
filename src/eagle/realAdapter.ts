import { ImportTimeoutError, type AppInfo, type EagleAdapter, type FolderInfo, type FolderPatch, type ItemFile, type ItemInfo, type ItemPatch, type LibrarySummary } from './adapter';

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
    modifiedAt: Number(it.modifiedAt ?? 0),
    star: Number(it.star ?? 0),
    annotation: String(it.annotation ?? ''),
    url: String(it.url ?? '')
  };
}

function toFolder(f: any): FolderInfo {
  const parentField = typeof f.parent === 'string' ? f.parent : f.parent && f.parent.id ? String(f.parent.id) : null;
  return { id: String(f.id), name: String(f.name ?? ''), parentId: parentField, createdAt: Number(f.createdAt ?? 0) };
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

  async createFolder(name: string, parentId: string | null): Promise<FolderInfo> {
    const e = api();
    const f = parentId === null ? await e.folder.create({ name }) : await e.folder.createSubfolder(parentId, { name });
    const info = toFolder(f);
    if (parentId !== null && info.parentId === null) info.parentId = parentId;
    return info;
  }

  async updateFolder(id: string, patch: FolderPatch): Promise<FolderInfo> {
    const f = await api().folder.getById(id);
    if (!f) throw new Error('文件夹不存在：' + id);
    if (patch.name !== undefined) f.name = patch.name;
    if (patch.description !== undefined) f.description = patch.description;
    if (patch.parentId !== undefined) f.parent = patch.parentId;
    await f.save();
    const fresh = toFolder((await api().folder.getById(id)) ?? f);
    if (patch.parentId !== undefined) fresh.parentId = patch.parentId;
    return fresh;
  }

  async importFile(filePath: string, opts: { name: string; folders: string[]; timeoutMs?: number }): Promise<string> {
    const p = api().item.addFromPath(filePath, { name: opts.name, folders: opts.folders });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ImportTimeoutError()), opts.timeoutMs ?? 20_000);
    });
    try {
      const r = await Promise.race([p, timeout]);
      return String(r && typeof r === 'object' ? (r.id ?? r.itemId) : r);
    } finally {
      if (timer) clearTimeout(timer);
      // 超时后 p 仍可能晚些 reject，避免未处理的拒绝
      p.catch(() => undefined);
    }
  }

  async replaceFile(id: string, filePath: string): Promise<void> {
    const it = await api().item.getById(id);
    if (!it) throw new Error('条目不存在：' + id);
    await it.replaceFile(filePath);
  }

  async trashItem(id: string): Promise<void> {
    const it = await api().item.getById(id);
    if (!it) throw new Error('条目不存在：' + id);
    await it.moveToTrash();
  }

  async updateItem(id: string, patch: ItemPatch): Promise<ItemFile> {
    const it = await api().item.getById(id);
    if (!it) throw new Error('条目不存在：' + id);
    if (patch.name !== undefined) it.name = patch.name;
    if (patch.folders !== undefined) it.folders = patch.folders;
    if (patch.tags !== undefined) it.tags = patch.tags;
    if (patch.star !== undefined) it.star = patch.star;
    if (patch.annotation !== undefined) it.annotation = patch.annotation;
    if (patch.url !== undefined) it.url = patch.url;
    await it.save();
    const fresh = await api().item.getById(id);
    if (!fresh) throw new Error('保存后无法读取条目：' + id);
    return { ...toItem(fresh), filePath: String(fresh.filePath ?? '') };
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
