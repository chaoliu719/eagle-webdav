import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface Config {
  /** 监听地址。默认仅本机，用户在状态窗口里选择局域网网卡后才对外。 */
  host: string;
  port: number;
  username: string;
  /** scrypt$N$salt(hex)$hash(hex)；null 表示尚未设置密码。 */
  passwordHash: string | null;
  /** 在内网默认白名单之外额外允许的 IPv4 网段，如 "100.64.0.0/10"。 */
  extraAllowedCidrs: string[];
  /** 是否暴露只读的「@标签」视图。 */
  tagsView: boolean;
  /** Eagle 启动后自动监听。 */
  autoStart: boolean;
}

export const DEFAULT_CONFIG: Config = {
  host: '127.0.0.1',
  port: 41600,
  username: 'eagle',
  passwordHash: null,
  extraAllowedCidrs: [],
  tagsView: true,
  autoStart: true
};

const SCRYPT_N = 16384;
const KEY_LEN = 32;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  if (!Number.isInteger(n) || n < 1024 || n > 1 << 20) return false;
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  if (!salt.length || expected.length !== KEY_LEN) return false;
  const actual = crypto.scryptSync(password, salt, KEY_LEN, { N: n });
  return crypto.timingSafeEqual(actual, expected);
}

function sanitize(raw: unknown): Config {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_CONFIG;
  const port = Number(r.port);
  return {
    host: typeof r.host === 'string' && r.host ? r.host : d.host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : d.port,
    username: typeof r.username === 'string' && r.username ? r.username : d.username,
    passwordHash: typeof r.passwordHash === 'string' && r.passwordHash ? r.passwordHash : null,
    extraAllowedCidrs: Array.isArray(r.extraAllowedCidrs) ? r.extraAllowedCidrs.filter((x): x is string => typeof x === 'string') : [],
    tagsView: typeof r.tagsView === 'boolean' ? r.tagsView : d.tagsView,
    autoStart: typeof r.autoStart === 'boolean' ? r.autoStart : d.autoStart
  };
}

/** 配置文件放在 dir/config.json，权限 0600，不放在插件目录以免更新时被覆盖。 */
export class ConfigStore {
  private file: string;
  private current: Config = { ...DEFAULT_CONFIG };

  constructor(dir: string) {
    this.file = path.join(dir, 'config.json');
  }

  load(): Config {
    try {
      this.current = sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      this.current = { ...DEFAULT_CONFIG };
    }
    return this.get();
  }

  get(): Config { return { ...this.current, extraAllowedCidrs: [...this.current.extraAllowedCidrs] }; }

  update(patch: Partial<Config>): Config {
    this.current = sanitize({ ...this.current, ...patch });
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.current, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.get();
  }

  setPassword(password: string): Config {
    return this.update({ passwordHash: hashPassword(password) });
  }
}
