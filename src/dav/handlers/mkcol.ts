import type * as http from 'http';
import { send } from '../../http/respond';
import { isSystemName } from '../../vfs/shadow';
import { isAllView, isCollection, pathKey } from '../../vfs/resolver';
import type { DavContext } from '../context';
import { parentSegsOf } from './common';

export async function handleMkcol(ctx: DavContext, req: http.IncomingMessage, res: http.ServerResponse, segs: string[]): Promise<void> {
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  req.resume();
  if (hasBody) return send(res, 415, {}, 'MKCOL 不支持请求体');
  if (segs.length === 0) return send(res, 405, {}, '已存在');
  const name = segs[segs.length - 1];
  const parent = await ctx.resolver.resolve(parentSegsOf(segs));
  if (!parent || !isCollection(parent)) return send(res, 409, {}, '父目录不存在');
  if (await ctx.resolver.resolve(segs)) return send(res, 405, {}, '已存在');

  if (isAllView(parent)) return send(res, 403, {}, '「@全部」是平铺视图，不能新建文件夹；请到具体文件夹里新建')
  if (parent.kind === 'shadow' || isSystemName(name)) {
    ctx.shadow.putDir(pathKey([...parent.segs, name]), name);
    return send(res, 201);
  }
  if (parent.kind === 'uncat') return send(res, 403, {}, '「@未分类」下不能创建文件夹');
  const parentId = parent.kind === 'folder' ? parent.folder.id : null;
  try {
    await ctx.adapter.createFolder(name, parentId);
  } catch (e) {
    ctx.logger.error(`创建文件夹失败 ${name}：${(e as Error).message}`);
    return send(res, 500, {}, '创建文件夹失败');
  }
  ctx.index.invalidate();
  send(res, 201);
}
