import * as crypto from 'crypto';
import { verifyPassword } from '../config/config';

const MAX_FAILURES = 10;
const BAN_MS = 10 * 60 * 1000;

export type AuthResult = 'ok' | 'denied' | 'banned';
export type Role = 'admin' | 'readonly';

export interface AuthConfig {
  username: string;
  passwordHash: string | null;
  readonlyUsername?: string;
  readonlyPasswordHash?: string | null;
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Basic 认证；同一源 IP 连续失败 10 次封禁 10 分钟。 */
export class Authenticator {
  private failures = new Map<string, { count: number; bannedUntil: number }>();

  constructor(private now: () => number = Date.now) {}

  /** 通过时返回角色；管理账号与只读账号分别校验。 */
  login(authorization: string | undefined, ip: string, cfg: AuthConfig): { result: AuthResult; role?: Role } {
    // 没设管理密码：不要求认证，任何访问都当管理账号（产品决定，见 CLAUDE.md）
    if (!cfg.passwordHash) return { result: 'ok', role: 'admin' };
    const rec = this.failures.get(ip);
    if (rec && rec.bannedUntil > this.now()) return { result: 'banned' };

    const role = this.verify(authorization, cfg);
    if (role) {
      this.failures.delete(ip);
      return { result: 'ok', role };
    }
    // 没带凭据是正常的认证握手，不计入失败
    if (authorization) this.fail(ip);
    return { result: 'denied' };
  }

  /** 兼容旧调用：只关心是否通过。 */
  check(authorization: string | undefined, ip: string, cfg: AuthConfig): AuthResult {
    return this.login(authorization, ip, cfg).result;
  }

  private verify(authorization: string | undefined, cfg: AuthConfig): Role | null {
    const m = /^Basic\s+(.+)$/i.exec(authorization || '');
    if (!m) return null;
    const s = Buffer.from(m[1], 'base64').toString('utf8');
    const i = s.indexOf(':');
    const user = i < 0 ? s : s.slice(0, i);
    const pass = i < 0 ? '' : s.slice(i + 1);
    // 两个账号都算一遍，避免通过耗时区分用户名对错
    const adminOk = safeEqual(user, cfg.username) && verifyPassword(pass, cfg.passwordHash);
    const roHash = cfg.readonlyUsername && cfg.readonlyUsername !== cfg.username ? cfg.readonlyPasswordHash ?? null : null;
    const roOk = safeEqual(user, cfg.readonlyUsername ?? '') && verifyPassword(pass, roHash);
    return adminOk ? 'admin' : roOk ? 'readonly' : null;
  }

  private fail(ip: string): void {
    const rec = this.failures.get(ip) ?? { count: 0, bannedUntil: 0 };
    if (rec.bannedUntil && rec.bannedUntil <= this.now()) { rec.count = 0; rec.bannedUntil = 0; }
    rec.count++;
    if (rec.count >= MAX_FAILURES) rec.bannedUntil = this.now() + BAN_MS;
    this.failures.set(ip, rec);
  }
}
