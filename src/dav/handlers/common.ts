import * as crypto from 'crypto';
import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';
import { ImportTimeoutError } from '../../eagle/adapter';
import { send } from '../../http/respond';
import { noteReq } from '../../util/reqctx';
import { eagleSanitizeName } from '../../vfs/naming';
import { pathKey, type Resolved } from '../../vfs/resolver';
import type { DavContext } from '../context';

export function splitExt(name: string): { base: string; ext: string } {
  const ext = path.extname(name).slice(1);
  return { base: ext ? name.slice(0, -(ext.length + 1)) : name, ext };
}

/** 条目名在 Eagle 去掉不支持的字符后为空（例如纯 emoji），导入后会得到随机名字，无法再按路径找到。 */
export function unusableItemName(name: string): boolean {
  const { base } = splitExt(name);
  return eagleSanitizeName(base + '.x') === '.x';
}

export function parentSegsOf(segs: string[]): string[] { return segs.slice(0, -1); }

/** 目标父目录对应的文件夹 id：真实文件夹返回 id，「@未分类」返回 null，其他不可放条目返回 undefined。 */
export function folderIdOf(parent: Resolved): string | null | undefined {
  if (parent.kind === 'folder') return parent.folder.id;
  if (parent.kind === 'uncat') return null;
  return undefined;
}

export async function makeTmpDir(ctx: DavContext): Promise<string> {
  const dir = path.join(ctx.tmpRoot, crypto.randomUUID());
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export async function removeDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export type ImportOutcome = { ok: true; id: string } | { ok: false; status: number; message: string };

/**
 * 把磁盘文件导入 Eagle：无扩展名直接 415（Eagle 会永不 resolve 并弹窗），
 * 其余带 20 秒超时，超时同样 415。
 */
export async function importAt(ctx: DavContext, file: string, name: string, folderId: string | null): Promise<ImportOutcome> {
  const { base, ext } = splitExt(name);
  if (!ext) return { ok: false, status: 415, message: 'Eagle 不支持没有扩展名的文件' };
  if (unusableItemName(name)) return { ok: false, status: 400, message: '文件名在 Eagle 中不可用（去掉不支持的字符后为空）' };
  try {
    const id = await ctx.adapter.importFile(file, { name: base, folders: folderId === null ? [] : [folderId] });
    ctx.index.invalidate();
    noteReq({ id });
    // 实测：内容与库内已有文件相同时 Eagle 立即返回 id，但会弹「重复添加提示」，等人确认后才真正入库
    // 以「目录列表里能否看到它」为准：弹重复提示时 getById 已经能返回条目，不能用它判断
    let landed = false;
    for (let i = 0; i < 3 && !landed; i++) {
      landed = await isListed(ctx, id, folderId);
      if (!landed) await new Promise((r) => setTimeout(r, 300));
    }
    if (!landed) watchPending(ctx, id, name, folderId);
    return { ok: true, id };
  } catch (e) {
    let bytes: number | undefined;
    try { bytes = fs.statSync(file).size; } catch { /* ignore */ }
    if (e instanceof ImportTimeoutError) {
      ctx.logger.log('error', 'imp', 'timeout', { name, ext, bytes, waitSec: 20 }, `导入超时 ${name}：Eagle 无法识别该文件格式`);
      return { ok: false, status: 415, message: 'Eagle 无法识别该文件格式（导入超时）' };
    }
    ctx.logger.log('error', 'imp', 'fail', { name, ext, bytes, err: (e as Error).message }, `导入失败 ${name}：${(e as Error).message}`);
    return { ok: false, status: 500, message: '导入失败' };
  }
}

const PENDING_POLL_MS = 5_000;
const PENDING_GIVE_UP_MS = 10 * 60_000;

/**
 * 导入后条目迟迟没有出现：多半是 Eagle 弹出了「重复添加提示」在等人确认。
 * 给用户一条可见的提示，并在后台轮询，条目一出现（或 10 分钟后）就撤销提示。
 */
async function isListed(ctx: DavContext, id: string, folderId: string | null): Promise<boolean> {
  try {
    return (await ctx.adapter.getItems(folderId)).some((i) => i.id === id);
  } catch {
    return false;
  }
}

export function watchPending(
  ctx: DavContext, id: string, name: string, folderId: string | null, pollMs = PENDING_POLL_MS, giveUpMs = PENDING_GIVE_UP_MS
): void {
  const key = 'pending:' + id;
  ctx.logger.log('info', 'imp', 'pending', { id, name }, `「${name}」在等 Eagle 的重复添加确认`);
  ctx.logger.notice(key, `「${name}」还没有入库：Eagle 弹出了「重复添加提示」，请到 Eagle 里点一下确认。`, { kind: 'warn', title: '有文件在等你确认' });
  const started = Date.now();
  const timer = setInterval(() => {
    void isListed(ctx, id, folderId).then((listed) => {
      if (listed || Date.now() - started > giveUpMs) {
        clearInterval(timer);
        ctx.logger.clearNotice(key);
        if (listed) ctx.index.invalidate();
        ctx.logger.log(listed ? 'info' : 'warn', 'imp', listed ? 'done' : 'giveup', { id, name, waitMs: Date.now() - started }, listed ? `「${name}」已入库` : `「${name}」等了 10 分钟仍未入库，不再跟踪`);
      }
    });
  }, pollMs);
  timer.unref?.();
}

/** 请求体尚未读取就要拒绝时：说明原因并关闭连接，避免客户端继续灌数据。 */
export function reject(req: http.IncomingMessage, res: http.ServerResponse, status: number, message: string): void {
  req.resume();
  send(res, status, { Connection: 'close' }, message);
}

export function keyOf(r: Resolved): string { return pathKey(r.segs); }
