import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LOG_LEVELS, type LogLevel } from '../util/log';

export interface Config {
  /** 监听地址。默认仅本机，用户在状态窗口里选择局域网网卡后才对外。 */
  host: string;
  /** 窗口里要求 1024–65535（1–1023 属系统保留端口，是否能监听取决于监听地址）。0 = 由系统分配临时端口，仅测试用。 */
  port: number;
  username: string;
  /** scrypt$N$salt(hex)$hash(hex)；null 表示尚未设置密码。 */
  passwordHash: string | null;
  /** 是否暴露只读的「@标签」视图。 */
  tagsView: boolean;
  /** 是否暴露只读的「@全部」视图（平铺列出全库条目）。只在配置文件里改，窗口里没有开关。 */
  allView: boolean;
  /** Eagle 启动后自动监听。 */
  autoStart: boolean;
  /** 用 Bonjour（dns-sd）广播 _webdav._tcp，Infuse 等 App 能自动发现（Finder 的「网络」不会列出 WebDAV，实测）。仅 macOS。 */
  bonjour: boolean;
  /** 有客户端连接时阻止 Mac 休眠（caffeinate）。仅 macOS。 */
  preventSleep: boolean;
  /** 文件日志级别，只在配置文件里改；debug 会逐条记录请求与 Eagle 调用。 */
  logLevel: LogLevel;
}

export const DEFAULT_CONFIG: Config = {
  host: '127.0.0.1',
  port: 41600,
  username: 'eagle',
  passwordHash: null,
  tagsView: true,
  allView: true,
  autoStart: true,
  bonjour: true,
  preventSleep: true,
  logLevel: 'info'
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
    port: Number.isInteger(port) && (port === 0 || (port >= 1024 && port < 65536)) ? port : d.port,
    username: typeof r.username === 'string' && r.username ? r.username : d.username,
    passwordHash: typeof r.passwordHash === 'string' && r.passwordHash ? r.passwordHash : null,
    tagsView: typeof r.tagsView === 'boolean' ? r.tagsView : d.tagsView,
    allView: typeof r.allView === 'boolean' ? r.allView : d.allView,
    autoStart: typeof r.autoStart === 'boolean' ? r.autoStart : d.autoStart,
    bonjour: typeof r.bonjour === 'boolean' ? r.bonjour : d.bonjour,
    preventSleep: typeof r.preventSleep === 'boolean' ? r.preventSleep : d.preventSleep,
    logLevel: LOG_LEVELS.includes(r.logLevel as LogLevel) ? (r.logLevel as LogLevel) : d.logLevel
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

  get(): Config { return { ...this.current }; }

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
