import type * as http from 'http';
import { send } from '../../http/respond';
import { isTagsView, pathKey } from '../../vfs/resolver';
import { writePreconditionFailed } from '../conditional';
import type { DavContext } from '../context';
import { etagOf } from '../props';

export async function handleDelete(ctx: DavContext, req: http.IncomingMessage, res: http.ServerResponse, segs: string[]): Promise<void> {
  req.resume();
  const r = await ctx.resolver.resolve(segs);
  if (!r) return send(res, 404, {}, 'Not Found');
  if (r.kind === 'item' && writePreconditionFailed(req.headers, etagOf(ctx.index.normalize(r.item)))) return send(res, 412, {}, 'Precondition Failed');
  if (isTagsView(r)) return send(res, 403, {}, '「@标签」视图只读');
  switch (r.kind) {
    case 'shadow':
      ctx.shadow.remove(pathKey(r.segs));
      ctx.deadProps.delete(pathKey(r.segs));
      return send(res, 204);
    case 'item': {
      const id = r.item.id;
      try {
        // 「一删全删」：条目属于多个文件夹时，会从所有文件夹消失
        await ctx.mutex.run(id, () => ctx.adapter.trashItem(id));
      } catch (e) {
        ctx.logger.error(`移入回收站失败 ${id}：${(e as Error).message}`);
        return send(res, 500, {}, '删除失败');
      }
      ctx.index.invalidate();
      ctx.deadProps.delete(pathKey(r.segs));
      return send(res, 204);
    }
    default:
      return send(res, 403, {}, 'Eagle 的 Plugin API 不提供删除文件夹的方法，请在 Eagle 中删除');
  }
}
