import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { send } from '../../http/respond';
import { isSystemName } from '../../vfs/shadow';
import { isCollection, isTagsView, pathKey } from '../../vfs/resolver';
import type { DavContext } from '../context';
import { folderIdOf, importAt, makeTmpDir, parentSegsOf, reject, removeDir, splitExt } from './common';

class LimitError extends Error {}

/** 把请求体落盘到 file，超过 limit 抛 LimitError。 */
async function writeBody(req: http.IncomingMessage, file: string, limit: number): Promise<number> {
  let n = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > limit) cb(new LimitError('too large'));
      else cb(null, chunk);
    }
  });
  await pipeline(req, counter, fs.createWriteStream(file));
  return n;
}

export async function handlePut(ctx: DavContext, req: http.IncomingMessage, res: http.ServerResponse, segs: string[]): Promise<void> {
  if (segs.length === 0) return reject(req, res, 405, '不能写入根目录');
  const name = segs[segs.length - 1];
  const parent = await ctx.resolver.resolve(parentSegsOf(segs));
  if (!parent || !isCollection(parent)) return reject(req, res, 409, '父目录不存在');
  const target = await ctx.resolver.resolve(segs);
  if (target && isCollection(target)) return reject(req, res, 405, '目标是集合');
  if (isTagsView(parent) || (target && isTagsView(target))) return reject(req, res, 403, '「@标签」视图只读');

  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > ctx.maxPut) return reject(req, res, 413, '文件过大');

  const key = pathKey([...parent.segs, name]);
  const isShadowPath = parent.kind === 'shadow' || isSystemName(name);
  const tmpDir = await makeTmpDir(ctx);
  const tmp = path.join(tmpDir, 'body');
  try {
    let size: number;
    try {
      size = await writeBody(req, tmp, ctx.maxPut);
    } catch (e) {
      if (e instanceof LimitError) return reject(req, res, 413, '文件过大');
      if ((e as NodeJS.ErrnoException).code === 'ENOSPC') return reject(req, res, 507, '磁盘空间不足');
      throw e;
    }

    // 系统文件、影子目录下的任何文件：只进影子暂存区
    if (isShadowPath) {
      const existed = target !== null;
      const dest = ctx.shadow.allocPath();
      if (size > 0) await fs.promises.rename(tmp, dest).catch(() => fs.promises.copyFile(tmp, dest));
      ctx.shadow.putFile(key, name, size > 0 ? dest : null, size);
      return send(res, existed ? 204 : 201);
    }

    const folderId = folderIdOf(parent);
    if (folderId === undefined) return send(res, 403, {}, '这里不能创建文件');
    if (parent.kind === 'root') return send(res, 403, {}, '请放入某个文件夹或 @未分类');

    // 0 字节且目标不存在：Finder 的占位写入，只登记，等后续带内容的 PUT
    if (size === 0 && (!target || target.kind === 'shadow')) {
      ctx.shadow.putFile(key, name, null, 0);
      return send(res, target ? 204 : 201);
    }

    if (target?.kind === 'item') {
      // 0 字节覆盖已有条目：多半是 Finder 先截断再写，忽略，等真正的内容
      if (size === 0) return send(res, 204);
      const ext = splitExt(name).ext.toLowerCase();
      if (ext !== target.item.ext.toLowerCase()) return send(res, 403, {}, '扩展名不能通过覆盖改变');
      const id = target.item.id;
      const file = path.join(tmpDir, name);
      await fs.promises.rename(tmp, file);
      await ctx.mutex.run(id, () => ctx.adapter.replaceFile(id, file));
      ctx.index.invalidate();
      return send(res, 204);
    }

    // 新建（目标不存在，或只有占位）
    const file = path.join(tmpDir, name);
    await fs.promises.rename(tmp, file);
    const out = await importAt(ctx, file, name, folderId);
    if (!out.ok) return send(res, out.status, {}, out.message);
    ctx.shadow.remove(key);
    return send(res, 201);
  } finally {
    await removeDir(tmpDir);
  }
}
