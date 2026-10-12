import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigStore } from './config/config';
import { MIN_BUILD, type EagleAdapter } from './eagle/adapter';
import { RealEagleAdapter, userDataDir } from './eagle/realAdapter';
import { DavRouter } from './dav/router';
import { DavServer } from './http/server';
import { LibraryIndex } from './index/libraryIndex';
import { StatusView, connectUrl, type InitialSettings, type SettingsForm } from './ui/status';
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
// 自动发现起不来、或中途退出：开关下方给一行黄字（没有别的副作用，服务本身不受影响）
const bonjour = new Bonjour({ onFail: () => view.setBonjourNote('自动发现没能启动，其他设备需要手动输入地址。') });
const server = new DavServer({
  getConfig: () => store.get(), logger, handler: (req, res) => router.handle(req, res),
  activity: { begin: () => sleepGuard.begin(), end: () => sleepGuard.end() }
});
// 需要用户注意的事（如 Eagle 在等「重复添加提示」确认）同时用 Eagle 自带的通知提醒一次
logger.onNotice = (n) => {
  try { eagle?.notification?.show({ title: n.title ? `Eagle WebDAV · ${n.title}` : 'Eagle WebDAV', description: n.message }); } catch { /* ignore */ }
};
const view = new StatusView(logger);

const NOTICE_START = 'start-failed';
const NOTICE_BUILD = 'build-low';

async function start(): Promise<void> {
  logger.clearNotice(NOTICE_START);
  const app = adapter.appInfo();
  // build 读不到（0）时无法判断，放行并留下日志
  if (app.build > 0 && app.build < MIN_BUILD) {
    logger.notice(NOTICE_BUILD, `需要 Eagle 4.0 Build ${MIN_BUILD} 或更高（当前 Build ${app.build}），请升级 Eagle。`, { kind: 'error', title: 'Eagle 版本过低' });
    return;
  }
  try {
    const info = await server.start();
    const lib = await adapter.libraryInfo().catch(() => null);
    view.setRunning(true);
    view.setAddress(connectUrl(info.host, info.port));
    view.setLibrary(lib ? lib.name : '');
    // 只在对局域网开放时才广播；仅本机监听没有意义
    view.setBonjourNote(null);
    const cfg = store.get();
    const discoverable = cfg.bonjour && info.host !== '127.0.0.1' && info.host !== '::1';
    if (discoverable) bonjour.start(info.port);
    if (adapter instanceof RealEagleAdapter) {
      adapter.diagnose().then((ls) => ls.forEach((l) => logger.info(l)), (e: Error) => logger.warn('形态自检失败：' + e.message));
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const port = store.get().port;
    const busy = err.code === 'EADDRINUSE';
    view.setRunning(false);
    // 启动失败要留着直到解决，并发 Eagle 系统通知：开机自动启动失败时窗口是关着的，用户不会知道
    logger.notice(NOTICE_START, busy ? `端口 ${port} 已被占用，可能有另一个程序正在使用它。` : err.message, {
      kind: 'error',
      title: '服务没能启动',
      actions: [
        ...(busy ? [{ label: '改端口', run: () => view.focusField('port') }] : []),
        { label: '重试', run: () => { void start(); } }
      ]
    });
  }
}

async function stop(): Promise<void> {
  bonjour.stop();
  sleepGuard.release();
  logger.clearNotice(NOTICE_START);
  await server.stop();
  view.setRunning(false);
  view.setBonjourNote(null);
}

function currentSettings(): InitialSettings {
  const c = store.get();
  return {
    host: c.host, port: c.port, username: c.username, hasPassword: !!c.passwordHash,
    bonjour: c.bonjour, preventSleep: c.preventSleep
  };
}

let saving = false;

/**
 * 保存设置：运行中则重启以应用，停止着则只保存（保存不改变运行 / 停止）。
 * 字段填错用行内错误，校验不通过时不保存、不重启；结果用 toast。
 */
async function save(form: SettingsForm): Promise<void> {
  if (saving) return;
  if (!form.username) return view.showFieldError('user', '账号不能为空');
  if (!Number.isInteger(form.port) || form.port < 1024 || form.port > 65535) return view.showFieldError('port', '端口应为 1024 到 65535 之间的数字');

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
    if (server.running) {
      await stop();
      await start();
      if (server.running) view.toast('已保存，服务已重启');
      else view.toast('已保存，但服务没能重新启动', 'error');
    } else {
      view.toast('已保存，下次启动时生效');
    }
  } catch (e) {
    logger.error('保存设置失败：' + (e as Error).message);
    view.toast(`没能保存：${(e as Error).message}`, 'error');
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
  setInterval(() => view.setAwake(sleepGuard.active && store.get().preventSleep), 2000);
  view.renderLog(true);

  if (cfg.autoStart) void start();
}

function registerLifecycle(): void {
  if (typeof eagle === 'undefined' || !eagle) return;
  eagle.onLibraryChanged?.(async (libraryPath) => {
    logger.info('资源库切换：' + libraryPath);
    server.setSwitching(true);
    try {
      // 清空索引缓存；后续里程碑在此一并清理锁与影子条目
      router.reset();
      const lib = await adapter.libraryInfo();
      view.setLibrary(lib.name);
      view.toast(`已切换到资源库「${lib.name}」`, 'info');
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
