import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigStore } from './config/config';
import { MIN_BUILD, type EagleAdapter } from './eagle/adapter';
import { instrumentAdapter } from './eagle/instrumented';
import { RealEagleAdapter, userDataDir } from './eagle/realAdapter';
import { DavRouter } from './dav/router';
import { DavServer } from './http/server';
import { LibraryIndex } from './index/libraryIndex';
import { StatusView, connectUrl, type InitialSettings, type SettingsForm } from './ui/status';
import { Bonjour } from './util/bonjour';
import { applyStaticI18n, setLocale, t } from './i18n';
import { copyText } from './ui/status';
import { buildDiagnostics } from './util/diagnostics';
import { FileLog } from './util/fileLog';
import { RingLogger } from './util/log';
import { Metrics } from './util/metrics';
import { SleepGuard } from './util/sleepGuard';

const logger = new RingLogger((level, msg) => {
  try { if (typeof eagle !== 'undefined') eagle?.log?.[level]?.('[webdav] ' + msg); } catch { /* ignore */ }
});

// userDataPath 在脚本加载瞬间可能还没就绪，所以到 init 时才确定配置目录
let configDir = '';
let store = new ConfigStore(path.join(os.homedir(), '.eagle-webdav', 'eagle-webdav'));
const realAdapter = new RealEagleAdapter();
// 每次调用 Eagle 接口都计时，累加到当前请求并在慢或出错时写日志
const adapter: EagleAdapter = instrumentAdapter(realAdapter, logger);
const metrics = new Metrics();
let fileLog: FileLog | null = null;
// 上次异常退出可能遗留的临时文件（PUT 缓冲、影子暂存区）
try { fs.rmSync(path.join(os.tmpdir(), 'eagle-webdav'), { recursive: true, force: true }); } catch { /* ignore */ }
const index = new LibraryIndex(adapter);
index.logger = logger;
const router = new DavRouter(adapter, index, logger, { allView: () => store.get().allView });
const sleepGuard = new SleepGuard({
  enabled: () => store.get().preventSleep,
  onChange: (active, inflight) => logger.log('info', 'sys', 'sleep', { active, inflight }, active ? '防休眠：已阻止 Mac 休眠' : '防休眠：已放开')
});
// 自动发现起不来、或中途退出：开关下方给一行黄字（没有别的副作用，服务本身不受影响）
const bonjour = new Bonjour({ label: () => t('bonjourName'), onFail: () => view.setBonjourNote(t('bonjourFail')) });
const server = new DavServer({
  getConfig: () => store.get(), logger, metrics, handler: (req, res) => router.handle(req, res),
  activity: { begin: () => sleepGuard.begin(), end: () => sleepGuard.end() }
});
// 需要用户注意的事（如 Eagle 在等「重复添加提示」确认）同时用 Eagle 自带的通知提醒一次
logger.onNotice = (n) => {
  try { eagle?.notification?.show({ title: n.title ? `${t('manifest.app.name')} · ${n.title}` : t('manifest.app.name'), description: n.message }); } catch { /* ignore */ }
};
const view = new StatusView(logger);

const NOTICE_START = 'start-failed';
const NOTICE_BUILD = 'build-low';

async function start(): Promise<void> {
  logger.clearNotice(NOTICE_START);
  const app = adapter.appInfo();
  // build 读不到（0）时无法判断，放行并留下日志
  if (app.build > 0 && app.build < MIN_BUILD) {
    logger.notice(NOTICE_BUILD, t('buildLow', { min: MIN_BUILD, cur: app.build }), { kind: 'error', title: t('buildLowTitle') });
    return;
  }
  try {
    const info = await server.start();
    // 上面的 listen 日志已记下监听信息
    const lib = await adapter.libraryInfo().catch(() => null);
    view.setRunning(true);
    view.setAddress(connectUrl(info.host, info.port));
    view.setLibrary(lib ? lib.name : '');
    // 只在对局域网开放时才广播；仅本机监听没有意义
    view.setBonjourNote(null);
    const cfg = store.get();
    const discoverable = cfg.bonjour && info.host !== '127.0.0.1' && info.host !== '::1';
    if (discoverable) {
      const ok = bonjour.start(info.port);
      logger.log(ok ? 'info' : 'warn', 'sys', 'bonjour', { ok, name: bonjour.name }, ok ? `自动发现：已注册「${bonjour.name}」` : '自动发现没能注册');
    }
    realAdapter.diagnose().then((ls) => ls.forEach((l) => logger.log('debug', 'svc', 'diagnose', { line: l }, l)), (e: Error) => logger.warn('形态自检失败：' + e.message));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const port = store.get().port;
    const busy = err.code === 'EADDRINUSE';
    view.setRunning(false);
    // 启动失败要留着直到解决，并发 Eagle 系统通知：开机自动启动失败时窗口是关着的，用户不会知道
    logger.notice(NOTICE_START, busy ? t('portBusy', { port }) : err.message, {
      kind: 'error',
      title: t('startFailTitle'),
      actions: [
        ...(busy ? [{ label: t('changePort'), run: () => view.focusField('port') }] : []),
        { label: t('retry'), run: () => { void start(); } }
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
  if (!form.username) return view.showFieldError('user', t('errUserEmpty'));
  if (!Number.isInteger(form.port) || form.port < 1024 || form.port > 65535) return view.showFieldError('port', t('errPort'));

  saving = true;
  view.setSaving(true);
  const before = { ...store.get() };
  try {
    if (form.password === '') store.update({ passwordHash: null });
    else if (form.password !== null) store.setPassword(form.password);
    store.update({
      host: form.host, port: form.port, username: form.username,
      bonjour: form.bonjour, preventSleep: form.preventSleep
    });
    view.applySettings(currentSettings());
    const after = store.get();
    // 只记改了哪些字段，不记值（密码尤其不能进日志）
    const changed = (['host', 'port', 'username', 'bonjour', 'preventSleep'] as const).filter((k) => before[k] !== after[k]) as string[];
    if (form.password !== null) changed.push('password');
    logger.log('info', 'svc', 'config', { changed, restart: server.running }, `设置已保存：${changed.join('、') || '无变化'}`);
    if (server.running) {
      await stop();
      await start();
      if (server.running) view.toast(t('savedRestarted'));
      else view.toast(t('savedRestartFailed'), 'error');
    } else {
      view.toast(t('savedNextStart'));
    }
  } catch (e) {
    logger.error('保存设置失败：' + (e as Error).message);
    view.toast(t('saveFailed', { msg: (e as Error).message }), 'error');
  } finally {
    saving = false;
    view.setSaving(false);
  }
}

/** 组装并复制诊断信息；资源库路径和用户主目录会被抹掉。 */
async function copyDiagnostics(): Promise<void> {
  try {
    const app = adapter.appInfo();
    const lib = await adapter.libraryInfo().catch(() => null);
    const cfg = store.get();
    const li = server.listenInfo;
    const text = buildDiagnostics({
      pluginVersion: __PLUGIN_VERSION__, eagleVersion: app.version, build: app.build,
      os: `${process.platform} ${os.release()}`, node: process.versions.node,
      libraryName: lib?.name ?? null, folderCount: lib?.folderCount ?? null,
      listen: li ? `${li.host}:${li.port}${li.ipv6 ? '（含 IPv6）' : ''}` : null,
      hasPassword: !!cfg.passwordHash, bonjour: cfg.bonjour, preventSleep: cfg.preventSleep,
      allView: cfg.allView, logLevel: cfg.logLevel,
      perf: metrics.summary(5 * 60_000), cache: index.stats,
      logLines: (fileLog?.tail(200) ?? []).filter((l) => !/"level":"debug"/.test(l)),
      redact: [[lib?.path ?? '', '<资源库>'], [os.homedir(), '~']]
    });
    if (await copyText(text)) view.toast(t('diagCopied'));
    else view.toast(t('diagCopyFailed'), 'error');
  } catch (e) {
    logger.error('生成诊断信息失败：' + (e as Error).message);
    view.toast(t('diagFailed', { msg: (e as Error).message }), 'error');
  }
}

function openLogFolder(): void {
  const dir = fileLog?.dir ?? path.join(configDir, 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(cmd, [dir], { stdio: 'ignore', detached: true }).unref();
  } catch (e) {
    view.toast(t('openLogsFailed', { msg: (e as Error).message }), 'error');
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
  // 界面语言跟随 Eagle（eagle.app.locale，要等 onPluginCreate 才读得到），没有的语言退回英文
  const locale = setLocale(typeof eagle !== 'undefined' ? eagle?.app?.locale : undefined);
  applyStaticI18n();
  // 文件日志默认开启；级别只在配置文件里改
  fileLog = new FileLog({ dir: path.join(configDir, 'logs') });
  logger.file = fileLog;
  logger.level = cfg.logLevel;
  logger.log('info', 'svc', 'start', { plugin: __PLUGIN_VERSION__, eagle: app.version, build: app.build, os: `${process.platform} ${os.release()}`, logLevel: cfg.logLevel, locale },
    `WebDAV 共享 ${__PLUGIN_VERSION__} · Eagle ${app.version} Build ${app.build}，配置目录 ${configDir}`);
  try {
    const keys = typeof eagle !== 'undefined' && eagle?.app ? Object.getOwnPropertyNames(Object.getPrototypeOf(eagle.app)).concat(Object.keys(eagle.app)) : [];
    logger.log('debug', 'svc', 'eagle-app', { members: keys }, 'eagle.app 成员：' + (keys.join(',') || '（无）'));
  } catch { /* ignore */ }

  view.bind({
    onStart() { void start(); },
    onStop() { void stop(); },
    onSave(form) { void save(form); },
    getSettings: currentSettings,
    onCopyDiagnostics() { void copyDiagnostics(); },
    onOpenLogs() { openLogFolder(); }
  });
  // 每 60 秒一条性能快照（这 60 秒内有请求才写）
  setInterval(() => {
    const s = metrics.takeSnapshot(60_000, index.stats);
    if (s.total === 0) return;
    logger.log('info', 'perf', 'snapshot', { windowSec: s.windowSec, req: s.req, p50: s.p50, p95: s.p95, cacheHit: s.cacheHit, heapMB: s.heapMB, inflightMax: s.inflightMax },
      `性能 ${s.total} 个请求 · p50 ${s.p50}ms · p95 ${s.p95}ms · 堆 ${s.heapMB}MB`);
  }, 60_000);
  setInterval(() => view.setAwake(sleepGuard.active && store.get().preventSleep), 2000);
  view.renderLog(true);

  if (cfg.autoStart) void start();
}

function registerLifecycle(): void {
  if (typeof eagle === 'undefined' || !eagle) return;
  eagle.onLibraryChanged?.(async (libraryPath) => {
    const t0 = Date.now();
    server.setSwitching(true);
    try {
      // 清空索引缓存；后续里程碑在此一并清理锁与影子条目
      router.reset();
      const lib = await adapter.libraryInfo();
      view.setLibrary(lib.name);
      logger.log('info', 'svc', 'library', { name: lib.name, ms: Date.now() - t0 }, `资源库切换：${lib.name}`);
      view.toast(t('libSwitched', { name: lib.name }), 'info');
    } catch (e) {
      logger.error('资源库重载失败：' + (e as Error).message);
    } finally {
      server.setSwitching(false);
    }
  });
  eagle.onPluginBeforeExit?.(() => {
    bonjour.stop();
    sleepGuard.release();
    void server.stop().then(() => { router.dispose(); fileLog?.dispose(); });
  });
}

// 页面被重载或关闭时，立刻放开子进程（dns-sd、caffeinate）
window.addEventListener('pagehide', () => {
  logger.log('info', 'svc', 'exit', {}, '插件页面关闭或重载');
  bonjour.stop();
  sleepGuard.release();
  fileLog?.flush();
});

// 兜底：未捕获的异常和未处理的 Promise 拒绝都记下来，不让它们悄无声息
const logUncaught = (kind: string, reason: unknown): void => {
  const err = reason as Error | undefined;
  logger.log('error', 'proc', 'uncaught', {
    kind, err: err?.message ?? String(reason), stack: (err?.stack ?? '').split('\n').slice(1, 4).map((l) => l.trim())
  }, `未捕获的错误（${kind}）：${err?.message ?? String(reason)}`);
};
window.addEventListener('error', (e) => logUncaught('error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => logUncaught('unhandledrejection', e.reason));
try { process.on('uncaughtException', (e) => logUncaught('uncaughtException', e)); } catch { /* ignore */ }

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
