import * as os from 'os';
import * as path from 'path';
import { ConfigStore } from './config/config';
import { MIN_BUILD, type EagleAdapter } from './eagle/adapter';
import { RealEagleAdapter, userDataDir } from './eagle/realAdapter';
import { DavRouter } from './dav/router';
import { DavServer } from './http/server';
import { LibraryIndex } from './index/libraryIndex';
import { StatusView, lanAddresses } from './ui/status';
import { RingLogger } from './util/log';

const logger = new RingLogger((level, msg) => {
  try { if (typeof eagle !== 'undefined') eagle?.log?.[level]?.('[webdav] ' + msg); } catch { /* ignore */ }
});

// userDataPath 在脚本加载瞬间可能还没就绪，所以到 init 时才确定配置目录
let configDir = '';
let store = new ConfigStore(path.join(os.homedir(), '.eagle-webdav', 'eagle-webdav'));
const adapter: EagleAdapter = new RealEagleAdapter();
const index = new LibraryIndex(adapter);
const router = new DavRouter(adapter, index, logger);
const server = new DavServer({ getConfig: () => store.get(), logger, handler: (req, res) => router.handle(req, res) });
const view = new StatusView(logger);

function urlsFor(host: string, port: number): string[] {
  if (host === '0.0.0.0') {
    return ['127.0.0.1', ...lanAddresses().map((a) => a.address)].map((h) => `http://${h}:${port}/`);
  }
  return [`http://${host}:${port}/`];
}

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
    view.setRunning(true, urlsFor(info.host, info.port));
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
  await server.stop();
  view.setRunning(false);
  view.setStatus('已停止');
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
    onStart(form) {
      if (form.password) store.setPassword(form.password);
      store.update({ host: form.host, port: form.port, username: form.username });
      void start();
    },
    onStop() { void stop(); }
  }, { host: cfg.host, port: cfg.port, username: cfg.username, hasPassword: !!cfg.passwordHash });
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
      index.invalidate();
      const lib = await adapter.libraryInfo();
      view.setStatus(`运行中 · 资源库：${lib.name}`);
    } catch (e) {
      logger.error('资源库重载失败：' + (e as Error).message);
    } finally {
      server.setSwitching(false);
    }
  });
  eagle.onPluginBeforeExit?.(() => { void server.stop(); });
}

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
