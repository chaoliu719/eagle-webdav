import * as os from 'os';
import { summarizeClients } from '../util/clients';
import type { RingLogger } from '../util/log';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface LanAddress { name: string; address: string }

export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] ?? []) {
      // 198.18.0.0/15 是基准测试保留网段，Surge 等代理软件的虚拟网卡会用到，手机连不上
      if (a.family === 'IPv4' && !a.internal && !/^198\.1[89]\./.test(a.address)) out.push({ name, address: a.address });
    }
  }
  return out;
}

/** 其他设备该填的地址：监听所有网卡时取第一块局域网网卡，否则就是监听地址本身。 */
export function connectUrl(host: string, port: number): string {
  const ip = host === '0.0.0.0' ? lanAddresses()[0]?.address ?? '127.0.0.1' : host;
  return `http://${ip}:${port}/`;
}

export interface SettingsForm {
  host: string;
  port: number;
  username: string;
  /** 密码：null = 不修改；'' = 清除；其他 = 设置为该值。 */
  password: string | null;
  bonjour: boolean;
  preventSleep: boolean;
}

export interface StatusHandlers {
  /** 用已保存的配置启动。 */
  onStart(): void;
  onStop(): void;
  /** 保存表单并自动启动（运行中则重启）。 */
  onSave(form: SettingsForm): void;
  /** 读取已保存的配置，供「放弃」恢复表单。 */
  getSettings(): InitialSettings;
  /** 「复制诊断信息」。 */
  onCopyDiagnostics(): void;
  /** 「打开日志文件夹」。 */
  onOpenLogs(): void;
}

export interface InitialSettings {
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  bonjour: boolean;
  preventSleep: boolean;
}

/**
 * 已设置的密码用一串黑点表示（真实密码不会回显，这里只是占位值）。
 * 黑点 = 不修改；清空 = 清除密码；输入新内容 = 设置新密码。点进去会全选，直接输入即替换。
 */
const MASK = '•'.repeat(10);

type Mode = 'local' | 'lan';
const LOCAL_HOSTS = ['127.0.0.1', '::1', 'localhost'];
const modeOf = (host: string): Mode => (LOCAL_HOSTS.includes(host) ? 'local' : 'lan');

function ago(ms: number): { text: string; now: boolean } {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return { text: '刚刚', now: true };
  if (s < 60) return { text: `${s} 秒前`, now: false };
  return { text: `${Math.round(s / 60)} 分钟前`, now: false };
}

const ICON_MONITOR = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
const ICON_TV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M9 21h6M12 17v4"/><path d="M10 9.5v4l3.5-2z"/></svg>';
const ICON_TERMINAL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/></svg>';

const ICON_ERROR = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.2v.1"/></svg>';
const ICON_WARN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.1"/></svg>';
const ICON_OK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_ERR_SM = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.2v.1"/></svg>';
const ICON_INFO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.9v.1"/></svg>';
const ICON_CLOSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export type ToastKind = 'ok' | 'error' | 'info';
const MAX_TOASTS = 3;

function iconFor(client: string): { svg: string; alt: boolean } {
  if (client === 'Infuse') return { svg: ICON_TV, alt: true };
  if (['rclone', 'curl', 'ffmpeg'].includes(client)) return { svg: ICON_TERMINAL, alt: false };
  return { svg: ICON_MONITOR, alt: false };
}

/** 写剪贴板；成功返回 true。 */
export async function copyText(text: string): Promise<boolean> {
  const fallback = (): boolean => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  };
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return fallback();
  }
}

export class StatusView {
  private lastRender = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private baseline = '';
  private baseForm!: SettingsForm;
  private baseMode: Mode = 'lan';
  private mode: Mode = 'lan';
  private address: string | null = null;

  constructor(private logger: RingLogger) {
    logger.onChange(() => this.renderLog(false));
    this.timer = setInterval(() => this.renderLog(true), 2000);
  }

  bind(handlers: StatusHandlers): void {
    this.applySettings(handlers.getSettings());

    for (const id of ['port', 'user', 'pass']) {
      $(id).addEventListener('input', () => {
        if (id !== 'pass') this.clearFieldError(id);
        this.updateDirty();
      });
    }
    $('modeLocal').addEventListener('click', () => this.setMode('local'));
    $('modeLan').addEventListener('click', () => this.setMode('lan'));
    for (const id of ['bonjour', 'nosleep']) {
      $(id).addEventListener('click', () => { this.setSwitch(id, !this.getSwitch(id)); this.updateDirty(); });
    }
    // 点进去全选黑点，直接输入就是替换；清空则表示清除密码（点「放弃」可恢复）
    const pass = $<HTMLInputElement>('pass');
    pass.addEventListener('focus', () => { if (pass.value === MASK) pass.select(); });

    $('svc').addEventListener('click', () => (this.getSwitch('svc') ? handlers.onStop() : handlers.onStart()));
    $('btnSave').addEventListener('click', () => handlers.onSave(this.readForm()));
    $('btnDiscard').addEventListener('click', () => this.applySettings(handlers.getSettings()));
    $('btnDiag').addEventListener('click', () => handlers.onCopyDiagnostics());
    $('btnLogs').addEventListener('click', () => handlers.onOpenLogs());
    $('btnCopy').addEventListener('click', () => {
      if (!this.address) return;
      void copyText(this.address);
      $('copyText').textContent = '已复制';
      setTimeout(() => { $('copyText').textContent = '复制'; }, 1200);
    });
  }

  private getSwitch(id: string): boolean { return $(id).getAttribute('aria-checked') === 'true'; }
  private setSwitch(id: string, on: boolean): void { $(id).setAttribute('aria-checked', on ? 'true' : 'false'); }

  private setMode(m: Mode): void {
    this.mode = m;
    $('modeLocal').setAttribute('aria-pressed', String(m === 'local'));
    $('modeLan').setAttribute('aria-pressed', String(m === 'lan'));
    if (this.baseForm) this.updateDirty();
  }

  /** 用已保存的配置填充表单（保存成功后、或点「放弃」时），并清空密码框。 */
  applySettings(s: InitialSettings): void {
    for (const k of ['port', 'user']) this.clearFieldError(k);
    this.baseMode = modeOf(s.host);
    this.mode = this.baseMode;
    $('modeLocal').setAttribute('aria-pressed', String(this.mode === 'local'));
    $('modeLan').setAttribute('aria-pressed', String(this.mode === 'lan'));
    $<HTMLInputElement>('port').value = String(s.port);
    $<HTMLInputElement>('user').value = s.username;
    this.setPassword(s.hasPassword);
    this.setSwitch('bonjour', s.bonjour);
    this.setSwitch('nosleep', s.preventSleep);
    // 「谁能访问」没动时保留原来的监听地址（可能是某个具体 IP）
    this.baseForm = { ...this.readForm(), host: s.host };
    this.baseline = JSON.stringify(this.baseForm);
    this.updateDirty();
  }

  private setPassword(isSet: boolean): void {
    const el = $<HTMLInputElement>('pass');
    el.value = isSet ? MASK : '';
    el.placeholder = isSet ? '' : '未设置';
    el.dataset.isSet = isSet ? '1' : '';
  }

  /** 密码框的意图：null = 不修改（黑点，或本来就没设置且仍为空）；'' = 清除；其他 = 新密码。 */
  private passwordValue(): string | null {
    const el = $<HTMLInputElement>('pass');
    if (el.value === MASK) return null;
    if (el.value === '' && !el.dataset.isSet) return null;
    return el.value;
  }

  private readForm(): SettingsForm {
    const host = this.baseForm && this.mode === this.baseMode ? this.baseForm.host : this.mode === 'local' ? '127.0.0.1' : '0.0.0.0';
    return {
      host,
      port: parseInt($<HTMLInputElement>('port').value, 10) || 0,
      username: $<HTMLInputElement>('user').value.trim(),
      password: this.passwordValue(),
      bonjour: this.getSwitch('bonjour'),
      preventSleep: this.getSwitch('nosleep')
    };
  }

  /** 有未保存的修改时才启用「保存」「放弃」，并在改动的字段旁标「已修改」。 */
  private updateDirty(): void {
    const cur = this.readForm();
    const dirty = JSON.stringify(cur) !== this.baseline;
    $<HTMLButtonElement>('btnSave').disabled = !dirty;
    $<HTMLButtonElement>('btnDiscard').disabled = !dirty;
    $('dirty').textContent = dirty ? '有未保存的修改' : '';
    const changed: Record<string, boolean> = {
      mode: this.mode !== this.baseMode,
      port: cur.port !== this.baseForm.port,
      user: cur.username !== this.baseForm.username,
      pass: cur.password !== null
    };
    document.querySelectorAll<HTMLElement>('.field[data-key]').forEach((el) => {
      el.classList.toggle('changed', !!changed[el.dataset.key as string]);
    });
  }

  setSaving(saving: boolean): void {
    if (saving) {
      $<HTMLButtonElement>('btnSave').disabled = true;
      $<HTMLButtonElement>('btnDiscard').disabled = true;
    } else {
      this.updateDirty();
    }
  }

  /**
   * Toast：操作的结果，说完就过去。成功 / 提示 3 秒消失，错误 6 秒且可点击关闭；最多同时 3 条。
   * 需要用户处理的问题不要用它，走 logger.notice（横幅 + 系统通知）。
   */
  toast(text: string, kind: ToastKind = 'ok'): void {
    const box = $('toasts');
    while (box.children.length >= MAX_TOASTS) box.firstElementChild?.remove();
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = kind === 'error' ? ICON_ERR_SM : kind === 'info' ? ICON_INFO : ICON_OK;
    const t = document.createElement('span');
    t.textContent = text;
    el.append(t);
    const close = () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 200);
    };
    if (kind === 'error') {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'x';
      x.setAttribute('aria-label', '关闭');
      x.innerHTML = ICON_CLOSE;
      x.addEventListener('click', close);
      el.append(x);
    }
    box.append(el);
    setTimeout(close, kind === 'error' ? 6000 : 3000);
  }

  /** 行内错误：红字贴在字段下面、字段变红框，并聚焦；改动该字段后自动消失。 */
  showFieldError(key: 'port' | 'user', message: string): void {
    const input = $<HTMLInputElement>(key);
    const err = $(`err-${key}`);
    err.textContent = message;
    err.hidden = false;
    input.classList.add('invalid');
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    input.select();
  }

  private clearFieldError(key: string): void {
    const input = $<HTMLInputElement>(key);
    input.classList.remove('invalid');
    input.removeAttribute('aria-invalid');
    $(`err-${key}`).hidden = true;
  }

  focusField(key: 'port' | 'user'): void {
    const el = $<HTMLInputElement>(key);
    el.scrollIntoView({ block: 'center' });
    el.focus();
    el.select();
  }

  /** 自动发现没能启动：开关下方一行黄字；null 表示正常。 */
  setBonjourNote(text: string | null): void {
    const el = $('bonjourNote');
    el.textContent = text ?? '';
    el.hidden = !text;
  }

  /** 「保持唤醒」标签：正在阻止 Mac 休眠时出现。 */
  setAwake(active: boolean): void {
    $('awake').hidden = !active;
  }

  setLibrary(name: string): void {
    $('library').textContent = name ? `资源库：${name}` : '资源库：—';
  }

  setRunning(running: boolean): void {
    this.setSwitch('svc', running);
    $('state').classList.toggle('on', running);
    $('stateText').textContent = running ? '运行中' : '未启动';
    if (!running) this.setAddress(null);
  }

  /** 其他设备要填的地址；null 表示服务没在运行。 */
  setAddress(url: string | null): void {
    this.address = url;
    const el = $('address');
    el.textContent = url ?? '启动后显示';
    el.classList.toggle('empty', !url);
    $<HTMLButtonElement>('btnCopy').disabled = !url;
  }

  renderLog(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastRender < 400) return;
    this.lastRender = now;

    const notices = $('notices');
    notices.textContent = '';
    for (const n of this.logger.activeNotices()) {
      const d = document.createElement('div');
      d.className = `banner ${n.kind}`;
      d.setAttribute('role', 'alert');
      d.innerHTML = n.kind === 'error' ? ICON_ERROR : ICON_WARN;
      const body = document.createElement('div');
      body.className = 'grow';
      if (n.title) {
        const t = document.createElement('div');
        t.className = 't';
        t.textContent = n.title;
        body.append(t);
      }
      const msg = document.createElement('div');
      msg.className = n.title ? 'd' : 't';
      msg.textContent = n.message;
      body.append(msg);
      d.append(body);
      if (n.actions.length) {
        const acts = document.createElement('div');
        acts.className = 'acts';
        n.actions.forEach((a, idx) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn' + (n.kind === 'error' && idx === n.actions.length - 1 ? ' primary' : '');
          b.textContent = a.label;
          b.addEventListener('click', () => { a.run(); this.renderLog(true); });
          acts.append(b);
        });
        d.append(acts);
      }
      notices.append(d);
    }

    const list = summarizeClients(this.logger.recent(), now).slice(0, 8);
    const box = $('devices');
    box.textContent = '';
    $('devCount').textContent = list.length ? `${list.length} 台` : '';
    $('devsCard').classList.toggle('is-empty', !list.length);
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-box';
      empty.innerHTML = ICON_MONITOR.replace('width="18" height="18"', 'width="22" height="22"');
      const t = document.createElement('span');
      t.textContent = '还没有设备连接';
      empty.append(t);
      box.append(empty);
    }
    for (const c of list) {
      const icon = iconFor(c.client);
      const when = ago(now - c.lastSeen);
      const row = document.createElement('div');
      row.className = 'dev';
      const ico = document.createElement('div');
      ico.className = 'ico' + (icon.alt ? ' alt' : '');
      ico.innerHTML = icon.svg;
      const info = document.createElement('div');
      info.className = 'grow';
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = c.client;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${c.ip} · ${c.requests} 次请求`;
      info.append(nm, meta);
      const w = document.createElement('div');
      w.className = 'when' + (when.now ? ' now' : '');
      w.textContent = when.text;
      row.append(ico, info, w);
      box.append(row);
    }

    const lines = this.logger.recent(60).map((e) =>
      `#${e.n} ${e.ip} ${e.method} ${decodeSafe(e.url)} → ${e.status} ${e.ms}ms${e.depth !== undefined ? ' Depth:' + e.depth : ''}${e.range ? ' Range:' + e.range : ''}${e.contentRange ? ' → ' + e.contentRange : ''}${e.length && !e.contentRange ? ' len:' + e.length : ''}${e.ua ? ' [' + e.ua.slice(0, 40) + ']' : ' [无UA]'}`);
    $('reqlog').textContent = lines.length ? lines.join('\n') : '（尚无请求）';
    $('msglog').textContent = this.logger.messages().slice(-30).join('\n');
  }
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
