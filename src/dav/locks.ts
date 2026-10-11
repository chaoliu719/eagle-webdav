import * as crypto from 'crypto';
import { escXml, hrefOf } from './path';

export interface Lock {
  token: string;
  path: string[];
  scope: 'exclusive' | 'shared';
  depth: string;
  /** 原样保留客户端给的 owner 内部 XML。 */
  ownerXml: string;
  timeout: number;
  expires: number;
}

/** 内存假锁：只为让 Finder 等客户端进入读写流程，不提供真实互斥以外的语义。 */
export class LockManager {
  private locks = new Map<string, Lock>();

  constructor(private now: () => number = Date.now) {}

  private purge(): void {
    const t = this.now();
    this.locks.forEach((l, k) => { if (l.expires <= t) this.locks.delete(k); });
  }

  create(path: string[], scope: 'exclusive' | 'shared', depth: string, ownerXml: string, timeoutSec: number): Lock {
    const token = crypto.randomUUID();
    const lock: Lock = { token, path, scope, depth, ownerXml, timeout: timeoutSec, expires: this.now() + timeoutSec * 1000 };
    this.locks.set(token, lock);
    return lock;
  }

  refresh(token: string, timeoutSec?: number): Lock | null {
    this.purge();
    const l = this.locks.get(token);
    if (!l) return null;
    if (timeoutSec) l.timeout = timeoutSec;
    l.expires = this.now() + l.timeout * 1000;
    return l;
  }

  remove(token: string): boolean { this.purge(); return this.locks.delete(token); }

  get(token: string): Lock | null { this.purge(); return this.locks.get(token) ?? null; }

  /** 影响某路径的锁：同路径，或祖先上 depth 为 infinity 的锁。 */
  covering(path: string[]): Lock[] {
    this.purge();
    const out: Lock[] = [];
    this.locks.forEach((l) => {
      const same = l.path.length === path.length && l.path.every((s, i) => s === path[i]);
      const ancestor = l.depth === 'infinity' && l.path.length < path.length && l.path.every((s, i) => s === path[i]);
      if (same || ancestor) out.push(l);
    });
    return out;
  }

  get size(): number { this.purge(); return this.locks.size; }
}

export function activeLockXml(l: Lock): string {
  return '<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:' + l.scope + '/></D:lockscope>' +
    '<D:depth>' + l.depth + '</D:depth>' +
    (l.ownerXml ? '<D:owner>' + l.ownerXml + '</D:owner>' : '') +
    '<D:timeout>Second-' + l.timeout + '</D:timeout>' +
    '<D:locktoken><D:href>opaquelocktoken:' + l.token + '</D:href></D:locktoken>' +
    '<D:lockroot><D:href>' + escXml(hrefOf(l.path, false)) + '</D:href></D:lockroot></D:activelock>';
}

export const SUPPORTED_LOCK_XML =
  '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
  '<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>';
