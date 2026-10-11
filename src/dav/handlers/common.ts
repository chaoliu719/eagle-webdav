import * as crypto from 'crypto';
import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';
import { ImportTimeoutError } from '../../eagle/adapter';
import { send } from '../../http/respond';
import { pathKey, type Resolved } from '../../vfs/resolver';
import type { DavContext } from '../context';

export function splitExt(name: string): { base: string; ext: string } {
  const ext = path.extname(name).slice(1);
  return { base: ext ? name.slice(0, -(ext.length + 1)) : name, ext };
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
  try {
    const id = await ctx.adapter.importFile(file, { name: base, folders: folderId === null ? [] : [folderId] });
    ctx.index.invalidate();
    // 实测：内容与库内已有文件相同时 Eagle 立即返回 id，但会弹「重复添加提示」，等人确认后才真正入库
    let landed = false;
    for (let i = 0; i < 5 && !landed; i++) {
      landed = (await ctx.adapter.getItemFile(id).catch(() => null)) !== null;
      if (!landed) await new Promise((r) => setTimeout(r, 300));
    }
    if (!landed) ctx.logger.warn(`导入 ${name} 尚未入库：Eagle 可能在等待「重复添加提示」的确认`);
    return { ok: true, id };
  } catch (e) {
    if (e instanceof ImportTimeoutError) return { ok: false, status: 415, message: 'Eagle 无法识别该文件格式（导入超时）' };
    ctx.logger.error(`导入失败 ${name}：${(e as Error).message}`);
    return { ok: false, status: 500, message: '导入失败' };
  }
}

/** 请求体尚未读取就要拒绝时：说明原因并关闭连接，避免客户端继续灌数据。 */
export function reject(req: http.IncomingMessage, res: http.ServerResponse, status: number, message: string): void {
  req.resume();
  send(res, status, { Connection: 'close' }, message);
}

export function keyOf(r: Resolved): string { return pathKey(r.segs); }
