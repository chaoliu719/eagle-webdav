import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';
import type { ItemFile } from '../../eagle/adapter';
import { send } from '../../http/respond';
import { buildName, cleanBase } from '../../vfs/naming';
import { isSystemName } from '../../vfs/shadow';
import { isCollection, isTagsView, pathKey, type Resolved } from '../../vfs/resolver';
import { writePreconditionFailed } from '../conditional';
import type { DavContext } from '../context';
import { etagOf } from '../props';
import { safeLibraryFile } from '../safeFile';
import { parseRequestPath } from '../path';
import { folderIdOf, importAt, unusableItemName, makeTmpDir, parentSegsOf, removeDir, splitExt } from './common';

/** 解析 Destination 头；主机与本服务不一致返回 'foreign'。 */
function parseDestination(req: http.IncomingMessage): string[] | 'bad' | 'foreign' {
  const raw = String(req.headers['destination'] ?? '');
  if (!raw) return 'bad';
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    let u: URL;
    try { u = new URL(raw); } catch { return 'bad'; }
    if (req.headers.host && u.host.toLowerCase() !== String(req.headers.host).toLowerCase()) return 'foreign';
    pathname = u.pathname;
  }
  const parsed = parseRequestPath(pathname);
  return parsed ? parsed.segs : 'bad';
}

function sameNode(a: Resolved, b: Resolved): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'item' && b.kind === 'item') return a.item.id === b.item.id;
  if (a.kind === 'folder' && b.kind === 'folder') return a.folder.id === b.folder.id;
  return pathKey(a.segs) === pathKey(b.segs);
}

function displayNameOf(it: ItemFile): string {
  return buildName(cleanBase(it.name) || it.id, it.ext);
}

export async function handleTransfer(
  ctx: DavContext, req: http.IncomingMessage, res: http.ServerResponse, srcSegs: string[], isMove: boolean
): Promise<void> {
  req.resume();
  const src = await ctx.resolver.resolve(srcSegs);
  if (!src) return send(res, 404, {}, 'Not Found');
  if (isMove && src.kind === 'item' && writePreconditionFailed(req.headers, etagOf(ctx.index.normalize(src.item)))) return send(res, 412, {}, 'Precondition Failed');
  const destSegs = parseDestination(req);
  if (destSegs === 'bad') return send(res, 400, {}, '缺少或无效的 Destination');
  if (destSegs === 'foreign') return send(res, 502, {}, '目标不在本服务');
  if (destSegs.length === 0) return send(res, 403, {}, '不能覆盖根目录');
  const overwrite = String(req.headers['overwrite'] ?? 'T').toUpperCase() !== 'F';
  const destName = destSegs[destSegs.length - 1];

  const destParent = await ctx.resolver.resolve(parentSegsOf(destSegs));
  if (!destParent || !isCollection(destParent)) return send(res, 409, {}, '目标父目录不存在');
  if (isTagsView(destParent) || (isMove && isTagsView(src))) return send(res, 403, {}, '「@标签」视图只读');
  const dest = await ctx.resolver.resolve(destSegs);

  if (dest && sameNode(src, dest) && pathKey(dest.segs) === pathKey(src.segs) && destName.normalize('NFC') === srcSegs[srcSegs.length - 1].normalize('NFC')) {
    return send(res, 403, {}, '源与目标相同');
  }

  // 成功响应发出之前就把 dead 属性处理好，客户端紧接着的 PROPFIND 才读得到
  const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => http.ServerResponse;
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    if (status >= 200 && status < 300) carryDeadProps(ctx, pathKey(src.segs), pathKey(destSegs), isMove);
    return writeHead(status, ...rest);
  }) as typeof res.writeHead;

  switch (src.kind) {
    case 'item': await transferItem(ctx, res, src, destParent, destName, dest, overwrite, isMove); break;
    case 'folder':
      if (!isMove) return send(res, 403, {}, '不支持复制文件夹');
      await moveFolder(ctx, res, src, destParent, destName, dest, overwrite);
      break;
    case 'shadow': await transferShadow(ctx, res, src, destParent, destName, dest, overwrite, isMove); break;
    default: return send(res, 403, {}, '不能移动或复制虚拟目录');
  }
}

/** dead 属性跟着资源走：目标原有的先清掉，MOVE 搬走、COPY 复制（含子路径）。 */
function carryDeadProps(ctx: DavContext, from: string, to: string, isMove: boolean): void {
  const inTree = (k: string, root: string): boolean => k === root || k.startsWith(root + '/');
  for (const k of [...ctx.deadProps.keys()]) if (inTree(k, to)) ctx.deadProps.delete(k);
  for (const [k, v] of [...ctx.deadProps.entries()]) {
    if (!inTree(k, from)) continue;
    ctx.deadProps.set(to + k.slice(from.length), new Map(v));
    if (isMove) ctx.deadProps.delete(k);
  }
}

/** 处理目标已存在：返回需要先清理的动作，或直接给出终止状态。 */
async function clearDest(
  ctx: DavContext, res: http.ServerResponse, src: Resolved, dest: Resolved | null, overwrite: boolean
): Promise<{ existed: boolean } | null> {
  if (!dest) return { existed: false };
  if (sameNode(src, dest)) return { existed: false }; // 同一对象的大小写改名等，不算覆盖
  if (!overwrite) { send(res, 412, {}, '目标已存在'); return null; }
  if (dest.kind === 'item') {
    const id = dest.item.id;
    await ctx.mutex.run(id, () => ctx.adapter.trashItem(id));
    ctx.index.invalidate();
    return { existed: true };
  }
  if (dest.kind === 'shadow' && !dest.entry.isDir) {
    ctx.shadow.remove(pathKey(dest.segs));
    return { existed: true };
  }
  send(res, 403, {}, '目标是文件夹，不能覆盖');
  return null;
}

async function transferItem(
  ctx: DavContext, res: http.ServerResponse, src: Extract<Resolved, { kind: 'item' }>, destParent: Resolved,
  destName: string, dest: Resolved | null, overwrite: boolean, isMove: boolean
): Promise<void> {
  if (destParent.kind === 'shadow' || isSystemName(destName)) return send(res, 403, {}, '不能移动到系统文件位置');
  if (destParent.kind === 'root') return send(res, 403, {}, '请放入某个文件夹或 @未分类');
  const dstFolder = folderIdOf(destParent);
  if (dstFolder === undefined) return send(res, 403, {}, '目标不可写');
  const srcFolder = src.parentFolderId;
  const sameDir = pathKey(destParent.segs) === pathKey(src.segs.slice(0, -1));

  const live = await ctx.adapter.getItemFile(src.item.id);
  if (!live) return send(res, 404, {}, 'Not Found');

  const extOk = live.ext
    ? destName.toLowerCase().endsWith('.' + live.ext.toLowerCase())
    : !splitExt(destName).ext;
  const newBase = live.ext ? destName.slice(0, -(live.ext.length + 1)) : destName;

  if (unusableItemName(destName)) return send(res, 400, {}, '文件名在 Eagle 中不可用（去掉不支持的字符后为空）');

  if (isMove) {
    if (!extOk) return send(res, 403, {}, '扩展名只读，不能通过改名修改');
    const cleared = await clearDest(ctx, res, src, dest, overwrite);
    if (!cleared) return;
    await ctx.mutex.run(live.id, async () => {
      const fresh = (await ctx.adapter.getItemFile(live.id)) ?? live;
      const patch: { name?: string; folders?: string[] } = {};
      if (displayNameOf(fresh) !== destName.normalize('NFC')) patch.name = newBase;
      if (!sameDir) {
        // 基于最新数据做增量修改：只移除源、只加入目标
        let folders = fresh.folders.filter((f) => f !== srcFolder);
        if (dstFolder !== null && !folders.includes(dstFolder)) folders = [...folders, dstFolder];
        patch.folders = folders;
      }
      if (Object.keys(patch).length) await ctx.adapter.updateItem(live.id, patch);
    });
    ctx.index.invalidate();
    return send(res, cleared.existed ? 204 : 201);
  }

  // COPY
  if (!sameDir && destName.normalize('NFC') === displayNameOf(live) && dstFolder !== null) {
    // 同名跨目录：按引用复制，只追加归属
    if (dest && sameNode(src, dest)) return send(res, 204);
    const cleared = await clearDest(ctx, res, src, dest, overwrite);
    if (!cleared) return;
    await ctx.mutex.run(live.id, async () => {
      const fresh = (await ctx.adapter.getItemFile(live.id)) ?? live;
      if (!fresh.folders.includes(dstFolder)) await ctx.adapter.updateItem(live.id, { folders: [...fresh.folders, dstFolder] });
    });
    ctx.index.invalidate();
    return send(res, cleared.existed ? 204 : 201);
  }

  // 真复制：复制磁盘文件并导入，再带上标签等元数据
  if (!extOk) return send(res, 403, {}, '扩展名只读，不能通过复制修改');
  const cleared = await clearDest(ctx, res, src, dest, overwrite);
  if (!cleared) return;
  const safe = await safeLibraryFile(await ctx.index.libraryPath(), live.filePath);
  if (!safe) return send(res, 404, {}, 'Not Found');
  const dir = await makeTmpDir(ctx);
  try {
    const tmp = path.join(dir, destName);
    await fs.promises.copyFile(safe.realPath, tmp);
    const out = await importAt(ctx, tmp, destName, dstFolder);
    if (!out.ok) return send(res, out.status, {}, out.message);
    const meta: { tags?: string[]; star?: number; annotation?: string; url?: string } = {};
    if (live.tags.length) meta.tags = live.tags;
    if (live.star) meta.star = live.star;
    if (live.annotation) meta.annotation = live.annotation;
    if (live.url) meta.url = live.url;
    if (Object.keys(meta).length) {
      await ctx.adapter.updateItem(out.id, meta).catch((e: Error) => ctx.logger.warn(`复制元数据失败：${e.message}`));
    }
    ctx.index.invalidate();
    return send(res, cleared.existed ? 204 : 201);
  } finally {
    await removeDir(dir);
  }
}

async function moveFolder(
  ctx: DavContext, res: http.ServerResponse, src: Extract<Resolved, { kind: 'folder' }>, destParent: Resolved,
  destName: string, dest: Resolved | null, overwrite: boolean
): Promise<void> {
  if (destParent.kind !== 'root' && destParent.kind !== 'folder') return send(res, 403, {}, '文件夹只能放在根目录或其他文件夹下');
  if (isSystemName(destName)) return send(res, 403, {}, '名字不可用');
  const newParent = destParent.kind === 'folder' ? destParent.folder.id : null;

  if (newParent !== null) {
    // 目标父目录不能是自己或后代
    const all = await ctx.index.folders();
    const byId = new Map(all.map((f) => [f.id, f]));
    for (let id: string | null = newParent; id; id = byId.get(id)?.parentId ?? null) {
      if (id === src.folder.id) return send(res, 409, {}, '不能移动到自身或其后代下');
    }
  }
  if (dest && !sameNode(src, dest)) {
    if (!overwrite) return send(res, 412, {}, '目标已存在');
    return send(res, 403, {}, '目标已存在，不能覆盖');
  }
  const patch: { name?: string; parentId?: string | null } = {};
  if (cleanBase(src.folder.name) !== destName.normalize('NFC')) patch.name = destName;
  if (src.folder.parentId !== newParent) patch.parentId = newParent;
  if (!Object.keys(patch).length) return send(res, 403, {}, '源与目标相同');
  await ctx.mutex.run('folder:' + src.folder.id, () => ctx.adapter.updateFolder(src.folder.id, patch));
  ctx.index.invalidate();
  send(res, 201);
}

async function transferShadow(
  ctx: DavContext, res: http.ServerResponse, src: Extract<Resolved, { kind: 'shadow' }>, destParent: Resolved,
  destName: string, dest: Resolved | null, overwrite: boolean, isMove: boolean
): Promise<void> {
  if (src.entry.isDir) return send(res, 403, {}, '不支持移动该目录');
  const cleared = await clearDest(ctx, res, src, dest, overwrite);
  if (!cleared) return;
  const toShadow = destParent.kind === 'shadow' || isSystemName(destName) || !src.entry.file;
  const destKey = pathKey([...destParent.segs, destName]);

  if (toShadow || src.entry.size === 0) {
    if (destParent.kind === 'root' && !isSystemName(destName)) return send(res, 403, {}, '请放入某个文件夹或 @未分类');
    if (isMove) {
      ctx.shadow.rename(pathKey(src.segs), destKey, destName);
    } else {
      let copy: string | null = null;
      if (src.entry.file) {
        copy = ctx.shadow.allocPath();
        await fs.promises.copyFile(src.entry.file, copy);
      }
      ctx.shadow.putFile(destKey, destName, copy, src.entry.size);
    }
    return send(res, cleared.existed ? 204 : 201);
  }

  // 带内容的影子文件移到真实位置：当作一次导入
  const folderId = folderIdOf(destParent);
  if (folderId === undefined || destParent.kind === 'root') return send(res, 403, {}, '目标不可写');
  const dir = await makeTmpDir(ctx);
  try {
    const tmp = path.join(dir, destName);
    await fs.promises.copyFile(src.entry.file as string, tmp);
    const out = await importAt(ctx, tmp, destName, folderId);
    if (!out.ok) return send(res, out.status, {}, out.message);
    if (isMove) ctx.shadow.remove(pathKey(src.segs));
    return send(res, cleared.existed ? 204 : 201);
  } finally {
    await removeDir(dir);
  }
}
