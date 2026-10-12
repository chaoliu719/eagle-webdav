import { AsyncLocalStorage } from 'async_hooks';
import * as crypto from 'crypto';

/** 一次 HTTP 请求的上下文：请求号、计时、调用 Eagle 的累计耗时，以及 handler 补充的字段。 */
export interface ReqCtx {
  rid: string;
  t0: number;
  /** 本次请求里所有 Eagle 接口调用耗时之和（并行调用会累加，可能大于总耗时）。 */
  eagleMs: number;
  eagleCalls: number;
  /** handler 通过 noteReq 补充的字段（条目 id、条目数等），随请求日志一起写出。 */
  fields: Record<string, unknown>;
  errored?: boolean;
}

const als = new AsyncLocalStorage<ReqCtx>();

export function newCtx(): ReqCtx {
  return { rid: crypto.randomBytes(3).toString('hex'), t0: Date.now(), eagleMs: 0, eagleCalls: 0, fields: {} };
}

export function runWithCtx<T>(ctx: ReqCtx, fn: () => T): T { return als.run(ctx, fn); }

export function currentCtx(): ReqCtx | undefined { return als.getStore(); }

/** 给当前请求补充日志字段；不在请求里时无操作。 */
export function noteReq(fields: Record<string, unknown>): void {
  const c = als.getStore();
  if (c) Object.assign(c.fields, fields);
}
