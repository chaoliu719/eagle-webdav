import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigStore } from './config/config';
import { MIN_BUILD, type EagleAdapter } from './eagle/adapter';
import { RealEagleAdapter, userDataDir } from './eagle/realAdapter';
import { DavRouter } from './dav/router';
import { DavServer } from './http/server';
import { LibraryIndex } from './index/libraryIndex';
import { StatusView, type InitialSettings, type SettingsForm } from './ui/status';
import { Bonjour } from './util/bonjour';
import { RingLogger } from './util/log';
import { SleepGuard } from './util/sleepGuard';

const logger = new RingLogger((level, msg) => {
  try { if (typeof eagle !== 'undefined') eagle?.log?.[level]?.('[webdav] ' + msg); } catch { /* ignore */ }
});

// userDataPath 在脚本加载瞬间可能还没就绪，所以到 init 时才确定配置目录
let configDir = '';
let store = new ConfigStore(path.join(os.homedir(), '.eagle-webdav', 'eagle-webdav'));
const adapter: EagleAdapter = new RealEagleAdapter();
// 上次异常退出可能遗留的临时文件（PUT 缓冲、影子暂存区）
try { fs.rmSync(path.join(os.tmpdir(), 'eagle-webdav'), { recursive: true, force: true }); } catch { /* ignore */ }
const index = new LibraryIndex(adapter);
const router = new DavRouter(adapter, index, logger, { tagsView: () => store.get().tagsView });
const sleepGuard = new SleepGuard({ enabled: () => store.get().preventSleep });
const bonjour = new Bonjour();
const server = new DavServer({
  getConfig: () => store.get(), logger, handler: (req, res) => router.handle(req, res),
  activity: { begin: () => sleepGuard.begin(), end: () => sleepGuard.end() }
});
// 需要用户注意的事（如 Eagle 在等「重复添加提示」确认）同时用 Eagle 自带的通知提醒一次
logger.onNotice = (n) => {
  try { eagle?.notification?.show({ title: 'Eagle WebDAV', description: n.message }); } catch { /* ignore */ }
};
const view = new StatusView(logger);

async function start(): Promise<void> {
  const app = adapter.appInfo();
  // build 读不到（0）时无法判断，放行并留下日志
  if (app.build > 0 && app.build < MIN_BUILD) {
    view.setStatus(`Eagle Build ${app.build} 过低，至少需要 Build ${MIN_BUILD}，请升级 Eagle`, true);
    return;
  }
  try {
    const info = await server.start();
    const lib = await adapter.libraryInfo().catch(() => null);
    view.setRunning(true);
    // 只在对局域网开放时才广播；仅本机监听没有意义
    const cfg = store.get();
    const discoverable = cfg.bonjour && info.host !== '127.0.0.1' && info.host !== '::1';
    if (discoverable) bonjour.start(info.port);
    if (adapter instanceof RealEagleAdapter) {
      adapter.diagnose().then((ls) => ls.forEach((l) => logger.info(l)), (e: Error) => logger.warn('形态自检失败：' + e.message));
    }
    view.setStatus(`运行中 · ${lib ? '资源库：' + lib.name : ''}`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const msg = err.code === 'EADDRINUSE' ? `端口 ${store.get().port} 已被占用` : err.message;
    logger.error('启动失败：' + msg);
    view.setRunning(false);
    view.setStatus('启动失败：' + msg, true);
  }
}

async function stop(): Promise<void> {
  bonjour.stop();
  sleepGuard.release();
  await server.stop();
  view.setRunning(false);
  view.setStatus('已停止');
}

function currentSettings(): InitialSettings {
  const c = store.get();
  return {
    host: c.host, port: c.port, username: c.username, hasPassword: !!c.passwordHash,
    bonjour: c.bonjour, preventSleep: c.preventSleep
  };
}

let saving = false;

/** 保存设置并自动启动（运行中则先停止再启动）。校验不通过时不保存、不重启，表单保持原样。 */
async function save(form: SettingsForm): Promise<void> {
  if (saving) return;
  const fail = (msg: string) => view.setStatus(msg, true);
  if (!form.username) return fail('管理账号的用户名不能为空');
  if (!Number.isInteger(form.port) || form.port < 1 || form.port > 65535) return fail('端口必须是 1 到 65535 之间的数字');

  saving = true;
  view.setSaving(true);
  try {
    if (form.password === '') store.update({ passwordHash: null });
    else if (form.password !== null) store.setPassword(form.password);
    store.update({
      host: form.host, port: form.port, username: form.username,
      bonjour: form.bonjour, preventSleep: form.preventSleep
    });
    view.applySettings(currentSettings());
    view.setStatus('已保存，正在重启服务…');
    if (server.running) await stop();
    await start();
  } finally {
    saving = false;
    view.setSaving(false);
  }
}

let initialized = false;

function init(): void {
  if (initialized) return;
  initialized = true;
  configDir = path.join(userDataDir() ?? path.join(os.homedir(), '.eagle-webdav'), 'eagle-webdav');
  store = new ConfigStore(configDir);
  const cfg = store.load();
  const app = adapter.appInfo();
  logger.info(`Eagle ${app.version} Build ${app.build}，配置目录 ${configDir}`);
  try {
    const keys = typeof eagle !== 'undefined' && eagle?.app ? Object.getOwnPropertyNames(Object.getPrototypeOf(eagle.app)).concat(Object.keys(eagle.app)) : [];
    logger.info('eagle.app 成员：' + (keys.join(',') || '（无）'));
  } catch { /* ignore */ }

  view.bind({
    onStart() { void start(); },
    onStop() { void stop(); },
    onSave(form) { void save(form); },
    getSettings: currentSettings
  });
  setInterval(() => view.setSleepState(sleepGuard.active, store.get().preventSleep), 2000);
  view.setStatus('已停止');
  view.renderLog(true);

  if (cfg.autoStart) void start();
}

function registerLifecycle(): void {
  if (typeof eagle === 'undefined' || !eagle) return;
  eagle.onLibraryChanged?.(async (libraryPath) => {
    logger.info('资源库切换：' + libraryPath);
    server.setSwitching(true);
    view.setStatus('资源库切换中…');
    try {
      // 清空索引缓存；后续里程碑在此一并清理锁与影子条目
      router.reset();
      const lib = await adapter.libraryInfo();
      view.setStatus(`运行中 · 资源库：${lib.name}`);
    } catch (e) {
      logger.error('资源库重载失败：' + (e as Error).message);
    } finally {
      server.setSwitching(false);
    }
  });
  eagle.onPluginBeforeExit?.(() => {
    bonjour.stop();
    sleepGuard.release();
    void server.stop().then(() => router.dispose());
  });
}

// 页面被重载或关闭时，立刻放开子进程（dns-sd、caffeinate）
window.addEventListener('pagehide', () => {
  bonjour.stop();
  sleepGuard.release();
});

document.addEventListener('DOMContentLoaded', () => {
  registerLifecycle();
  // 优先等 onPluginCreate，此时 eagle.app 已就绪；取不到事件则兜底延迟初始化
  if (typeof eagle !== 'undefined' && eagle?.onPluginCreate) {
    eagle.onPluginCreate(() => init());
    setTimeout(init, 3000);
  } else {
    init();
  }
});
