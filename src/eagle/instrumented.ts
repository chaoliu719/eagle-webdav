import type { EagleAdapter } from './adapter';
import { ImportTimeoutError } from './adapter';
import type { Logger } from '../util/log';
import { currentCtx } from '../util/reqctx';

export const SLOW_EAGLE_MS = 500;

/** 参数的"形状"：只留类型与数量，不带内容（路径、名字、id 都不进日志）。 */
export function argShape(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === 'string') return 'str';
    if (Array.isArray(a)) return `arr${a.length}`;
    if (a && typeof a === 'object') return '{' + Object.keys(a).join(',') + '}';
    return String(a);
  }).join(',');
}

function count(v: unknown): number | undefined {
  return Array.isArray(v) ? v.length : undefined;
}

/**
 * 给适配器套一层计时：每次调用累加到当前请求的 eagleMs，慢调用与报错写日志。
 * 不改变任何返回值和异常，realAdapter.ts 保持不动。
 */
export function instrumentAdapter<T extends EagleAdapter>(inner: T, logger: Logger, slowMs = SLOW_EAGLE_MS): T {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function' || prop === 'appInfo' || typeof prop !== 'string') return v;
      return (...args: unknown[]) => {
        const t0 = Date.now();
        const ctx = currentCtx();
        const done = (): number => {
          const ms = Date.now() - t0;
          if (ctx) { ctx.eagleMs += ms; ctx.eagleCalls++; }
          return ms;
        };
        let r: unknown;
        try { r = v.apply(target, args); } catch (e) {
          done();
          throw e;
        }
        if (!r || typeof (r as Promise<unknown>).then !== 'function') return r;
        return (r as Promise<unknown>).then((val) => {
          const ms = done();
          if (ms >= slowMs) logger.log('warn', 'eagle', 'slow', { fn: prop, ms, n: count(val) });
          else logger.log('debug', 'eagle', 'call', { fn: prop, ms, n: count(val) });
          return val;
        }, (e: Error) => {
          const ms = done();
          // 导入超时是预期内的（由 importAt 记 imp.timeout），不当作接口故障
          if (!(e instanceof ImportTimeoutError)) logger.log('error', 'eagle', 'error', { fn: prop, ms, args: argShape(args), err: e?.message });
          throw e;
        });
      };
    }
  });
}
