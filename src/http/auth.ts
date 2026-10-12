import * as crypto from 'crypto';
import { verifyPassword } from '../config/config';

const MAX_FAILURES = 10;
const BAN_MS = 10 * 60 * 1000;

export type AuthResult = 'ok' | 'denied' | 'banned';

export interface AuthConfig {
  username: string;
  passwordHash: string | null;
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Basic 认证；同一源 IP 连续失败 10 次封禁 10 分钟。 */
export class Authenticator {
  private failures = new Map<string, { count: number; bannedUntil: number }>();
  /** 失败 / 封禁的回调（server 用来写日志）；只传来源和次数，不含尝试的账号密码。 */
  events: { fail?(ip: string, count: number): void; ban?(ip: string, minutes: number): void } = {};

  constructor(private now: () => number = Date.now) {}

  /** 没设管理密码时不要求认证（产品决定）；设了则校验账号密码，失败计数，连续失败会被封禁。 */
  check(authorization: string | undefined, ip: string, cfg: AuthConfig): AuthResult {
    if (!cfg.passwordHash) return 'ok';
    const rec = this.failures.get(ip);
    if (rec && rec.bannedUntil > this.now()) return 'banned';

    if (this.verify(authorization, cfg)) {
      this.failures.delete(ip);
      return 'ok';
    }
    // 没带凭据是正常的认证握手，不计入失败
    if (authorization) this.fail(ip);
    return 'denied';
  }

  private verify(authorization: string | undefined, cfg: AuthConfig): boolean {
    const m = /^Basic\s+(.+)$/i.exec(authorization || '');
    if (!m) return false;
    const s = Buffer.from(m[1], 'base64').toString('utf8');
    const i = s.indexOf(':');
    const user = i < 0 ? s : s.slice(0, i);
    const pass = i < 0 ? '' : s.slice(i + 1);
    // 先后都算，避免通过耗时区分用户名对错
    const userOk = safeEqual(user, cfg.username);
    const passOk = verifyPassword(pass, cfg.passwordHash);
    return userOk && passOk;
  }

  private fail(ip: string): void {
    const rec = this.failures.get(ip) ?? { count: 0, bannedUntil: 0 };
    if (rec.bannedUntil && rec.bannedUntil <= this.now()) { rec.count = 0; rec.bannedUntil = 0; }
    rec.count++;
    this.failures.set(ip, rec);
    this.events.fail?.(ip, rec.count);
    if (rec.count >= MAX_FAILURES) {
      rec.bannedUntil = this.now() + BAN_MS;
      this.events.ban?.(ip, BAN_MS / 60_000);
    }
  }
}
